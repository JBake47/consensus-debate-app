function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeProvider(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 'unknown';
  if (id.includes(':')) {
    const prefix = id.split(':')[0];
    return prefix === 'google' ? 'gemini' : prefix;
  }
  const prefix = id.split('/')[0];
  return prefix === 'google' ? 'gemini' : prefix;
}

export function getEstimatedModelPricingPerMillion(modelInfo = {}) {
  const pricing = modelInfo?.pricing || {};
  const promptRaw = toFiniteNumber(
    pricing.prompt ?? pricing.input ?? pricing.input_per_token ?? pricing.prompt_per_token,
  );
  const completionRaw = toFiniteNumber(
    pricing.completion ?? pricing.output ?? pricing.output_per_token ?? pricing.completion_per_token,
  );

  const promptPerToken = promptRaw != null
    ? (promptRaw > 0.01 ? promptRaw / 1_000_000 : promptRaw)
    : null;
  const completionPerToken = completionRaw != null
    ? (completionRaw > 0.01 ? completionRaw / 1_000_000 : completionRaw)
    : null;

  const promptPerMillion = promptPerToken != null ? promptPerToken * 1_000_000 : null;
  const completionPerMillion = completionPerToken != null ? completionPerToken * 1_000_000 : null;

  const inputPerMillion = promptPerMillion ?? completionPerMillion;
  const outputPerMillion = completionPerMillion ?? promptPerMillion;
  if (inputPerMillion == null || outputPerMillion == null) return null;
  return { inputPerMillion, outputPerMillion };
}

function getContextLength(modelInfo = {}) {
  return (
    toFiniteNumber(modelInfo?.context_length) ??
    toFiniteNumber(modelInfo?.contextWindow) ??
    toFiniteNumber(modelInfo?.architecture?.context_length) ??
    0
  );
}

export function scoreModel({
  modelId,
  modelInfo,
  metrics,
  preferredMode = 'balanced',
}) {
  const pricing = getEstimatedModelPricingPerMillion(modelInfo);
  const averagePrice = pricing
    ? (pricing.inputPerMillion + pricing.outputPerMillion) / 2
    : null;
  const costScore = averagePrice == null
    ? 45
    : clamp(100 - Math.log10(Math.max(1e-6, averagePrice)) * 35, 0, 100);

  const contextLength = getContextLength(modelInfo);
  const contextScore = contextLength > 0
    ? clamp(Math.log2(contextLength) * 7, 0, 100)
    : 40;

  const modelIdLower = String(modelId || '').toLowerCase();
  const provider = normalizeProvider(modelIdLower);
  const failureByProvider = metrics?.failureByProvider && typeof metrics.failureByProvider === 'object'
    ? metrics.failureByProvider
    : {};
  const providerFailures = Number(failureByProvider[provider] || 0);
  const reliabilityScore = clamp(100 - providerFailures * 6, 20, 100);

  const speedHeuristic = (
    modelIdLower.includes('flash') ||
    modelIdLower.includes('mini') ||
    modelIdLower.includes('haiku') ||
    modelIdLower.includes('instant')
  ) ? 90 : (
    modelIdLower.includes('sonnet') ||
    modelIdLower.includes('turbo') ||
    modelIdLower.includes('fast')
  ) ? 72 : 55;

  const qualityHeuristic = (
    modelIdLower.includes('opus') ||
    modelIdLower.includes('gpt-5') ||
    modelIdLower.includes('o3') ||
    modelIdLower.includes('pro')
  ) ? 92 : (
    modelIdLower.includes('sonnet') ||
    modelIdLower.includes('gpt-4') ||
    modelIdLower.includes('r1')
  ) ? 80 : 66;

  const weightsByMode = {
    fast: { speed: 0.45, reliability: 0.25, cost: 0.2, quality: 0.05, context: 0.05 },
    quality: { speed: 0.1, reliability: 0.2, cost: 0.1, quality: 0.45, context: 0.15 },
    cheap: { speed: 0.15, reliability: 0.2, cost: 0.45, quality: 0.1, context: 0.1 },
    balanced: { speed: 0.25, reliability: 0.3, cost: 0.2, quality: 0.15, context: 0.1 },
  };
  const weights = weightsByMode[preferredMode] || weightsByMode.balanced;

  const total = (
    speedHeuristic * weights.speed +
    reliabilityScore * weights.reliability +
    costScore * weights.cost +
    qualityHeuristic * weights.quality +
    contextScore * weights.context
  );

  return {
    modelId,
    score: Math.round(total * 10) / 10,
    provider,
    pricing,
    signals: {
      speed: speedHeuristic,
      reliability: reliabilityScore,
      cost: costScore,
      quality: qualityHeuristic,
      context: contextScore,
    },
  };
}

export function rankModels({
  modelCatalog = {},
  metrics = null,
  preferredMode = 'balanced',
  limit = 8,
}) {
  const ranked = Object.entries(modelCatalog)
    .map(([modelId, modelInfo]) => scoreModel({
      modelId,
      modelInfo,
      metrics,
      preferredMode,
    }))
    .sort((a, b) => b.score - a.score);
  if (!Number.isFinite(limit) || limit <= 0) return ranked;
  return ranked.slice(0, limit);
}
