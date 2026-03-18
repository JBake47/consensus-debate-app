function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeCompletedModelIds(completedStreams = []) {
  return Array.from(new Set(
    (Array.isArray(completedStreams) ? completedStreams : [])
      .map((stream) => String(stream?.model || '').trim())
      .filter(Boolean)
  ));
}

function normalizeWeightMap(modelIds, rawWeights = {}) {
  const normalized = {};
  const missing = [];
  let providedTotal = 0;

  for (const modelId of modelIds) {
    const candidate = Number(rawWeights?.[modelId]);
    if (Number.isFinite(candidate) && candidate > 0) {
      normalized[modelId] = candidate;
      providedTotal += candidate;
    } else {
      missing.push(modelId);
    }
  }

  if (providedTotal <= 0) {
    const equalShare = modelIds.length > 0 ? 1 / modelIds.length : 0;
    return Object.fromEntries(modelIds.map((modelId) => [modelId, equalShare]));
  }

  const remainingMass = Math.max(0, 1 - providedTotal);
  const fallbackShare = missing.length > 0 ? remainingMass / missing.length : 0;

  for (const modelId of missing) {
    normalized[modelId] = fallbackShare;
  }

  const total = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    const equalShare = modelIds.length > 0 ? 1 / modelIds.length : 0;
    return Object.fromEntries(modelIds.map((modelId) => [modelId, equalShare]));
  }

  return Object.fromEntries(
    Object.entries(normalized).map(([modelId, value]) => [modelId, value / total])
  );
}

export function buildEnsembleQualityObservations({
  completedStreams = [],
  voteAnalysis = null,
} = {}) {
  const modelIds = normalizeCompletedModelIds(completedStreams);
  if (modelIds.length === 0) return {};

  const normalizedWeights = normalizeWeightMap(modelIds, voteAnalysis?.modelWeights || {});
  const outlierIds = new Set(
    (Array.isArray(voteAnalysis?.outliers) ? voteAnalysis.outliers : [])
      .map((entry) => String(entry?.model || '').trim())
      .filter(Boolean)
  );
  const maxWeight = Object.values(normalizedWeights).reduce((best, value) => Math.max(best, value), 0);
  const signalWeight = clamp(Number(voteAnalysis?.confidence ?? 50) / 100, 0.35, 1);

  return Object.fromEntries(
    modelIds.map((modelId) => {
      const normalizedWeight = Number(normalizedWeights?.[modelId] || 0);
      const relativeWeight = normalizedWeight * modelIds.length;
      const topPlacement = normalizedWeight >= (maxWeight - 0.025);
      const outlier = outlierIds.has(modelId);
      return [
        modelId,
        {
          qualityVoteCountDelta: 1,
          judgeSignalWeightDelta: signalWeight,
          judgeRelativeWeightDelta: relativeWeight * signalWeight,
          judgeTopPlacementDelta: topPlacement ? signalWeight : 0,
          judgeOutlierDelta: outlier ? signalWeight : 0,
        },
      ];
    })
  );
}
