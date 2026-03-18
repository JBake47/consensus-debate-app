import { getModelImageSupport } from './modelCapabilities.js';
import { resolveModelBenchmarkProfile } from './modelBenchmarks.js';
import { getCatalogModelLookupId } from './modelStats.js';
import { getTransportProviderId } from './modelTransport.js';
import { buildDebateParticipantWorkloadProfile } from './modelWorkload.js';

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundToTenths(value) {
  return Math.round(value * 10) / 10;
}

function compactInteger(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${roundToTenths(value / 1_000_000)}M`;
  if (value >= 1_000) return `${roundToTenths(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function formatUsd(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 0.01) return `$${value.toFixed(3)}`;
  if (value < 0.1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(1)}`;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 10000) return `${roundToTenths(value / 1000)}s`;
  return `${Math.round(value / 1000)}s`;
}

function blendScores(fallbackScore, measuredScore, confidence = 0) {
  if (!Number.isFinite(measuredScore)) return fallbackScore;
  const weight = clamp(confidence, 0, 1);
  return fallbackScore * (1 - weight) + measuredScore * weight;
}

function getMetricsModelKey(modelId) {
  return getCatalogModelLookupId(modelId) || String(modelId || '').trim();
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

function normalizeTransportProvider(modelId) {
  return getTransportProviderId(modelId || '');
}

function parseTimestampToMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value);
    if (value > 1e9) return Math.floor(value * 1000);
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return parseTimestampToMs(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getModelReleaseTimestampMs(modelInfo = {}) {
  const createdCandidates = [
    modelInfo.created,
    modelInfo.created_at,
    modelInfo.createdAt,
    modelInfo.release_date,
    modelInfo.released_at,
    modelInfo.releasedAt,
    modelInfo.top_provider?.created,
    modelInfo.top_provider?.created_at,
    modelInfo.architecture?.created_at,
    modelInfo.architecture?.released_at,
  ];
  for (const candidate of createdCandidates) {
    const parsed = parseTimestampToMs(candidate);
    if (parsed != null) return parsed;
  }

  const fallbackCandidates = [
    modelInfo.updated,
    modelInfo.updated_at,
    modelInfo.updatedAt,
    modelInfo.last_updated,
    modelInfo.lastUpdated,
    modelInfo.top_provider?.updated,
    modelInfo.top_provider?.updated_at,
  ];
  for (const candidate of fallbackCandidates) {
    const parsed = parseTimestampToMs(candidate);
    if (parsed != null) return parsed;
  }

  return null;
}

function getRecencyScore(releasedAtMs, nowMs = Date.now()) {
  if (!releasedAtMs || !Number.isFinite(releasedAtMs)) return 50;
  const ageDays = Math.max(0, (nowMs - releasedAtMs) / (24 * 60 * 60 * 1000));
  return clamp(100 - Math.log2(1 + ageDays) * 6, 35, 100);
}

function getReleaseNoveltyScore(releasedAtMs, nowMs = Date.now()) {
  if (!releasedAtMs || !Number.isFinite(releasedAtMs)) return 48;
  const ageDays = Math.max(0, (nowMs - releasedAtMs) / (24 * 60 * 60 * 1000));
  return clamp(100 - Math.log2(1 + ageDays) * 10, 20, 100);
}

function isPreviewModel(modelId, modelInfo = {}) {
  if (modelInfo?.is_preview === true || modelInfo?.preview === true || modelInfo?.top_provider?.is_preview === true) {
    return true;
  }
  const joined = [
    modelId,
    modelInfo?.id,
    modelInfo?.name,
    modelInfo?.description,
    Array.isArray(modelInfo?.tags) ? modelInfo.tags.join(' ') : '',
    modelInfo?.top_provider?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!joined) return false;
  return (
    joined.includes('preview') ||
    joined.includes('beta') ||
    joined.includes('experimental') ||
    joined.includes('alpha') ||
    joined.includes('nightly') ||
    joined.includes('canary') ||
    joined.includes('rc')
  );
}

const FLAGSHIP_PATTERNS = [
  /\bgpt-5\b/i,
  /\bo3\b/i,
  /\bo1\b/i,
  /\bclaude[-\s]?4\b/i,
  /\bclaude[-\s]?3\.7\b/i,
  /\bopus\b/i,
  /\bgemini[-\s]?3\b/i,
  /\bgemini[-\s]?2\.5[-\s]?(pro|ultra)\b/i,
  /\bllama[-\s]?4\b/i,
  /\bgrok[-\s]?3\b/i,
  /\bmistral[-\s]?large\b/i,
  /\bcommand[-\s]?r\+\b/i,
];

function isFlagshipModel(modelId, modelInfo = {}) {
  if (
    modelInfo?.is_flagship === true ||
    modelInfo?.flagship === true ||
    modelInfo?.top_provider?.is_flagship === true
  ) {
    return true;
  }
  const tier = String(
    modelInfo?.tier ||
    modelInfo?.capabilities?.tier ||
    modelInfo?.top_provider?.tier ||
    ''
  ).toLowerCase();
  if (tier.includes('flagship') || tier.includes('frontier') || tier.includes('state-of-the-art')) {
    return true;
  }
  const text = [
    modelId,
    modelInfo?.id,
    modelInfo?.name,
    modelInfo?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  return FLAGSHIP_PATTERNS.some((pattern) => pattern.test(text));
}

function getSpeedHeuristic(modelIdLower) {
  if (
    modelIdLower.includes('flash') ||
    modelIdLower.includes('mini') ||
    modelIdLower.includes('haiku') ||
    modelIdLower.includes('instant')
  ) {
    return 90;
  }
  if (
    modelIdLower.includes('sonnet') ||
    modelIdLower.includes('turbo') ||
    modelIdLower.includes('fast')
  ) {
    return 72;
  }
  return 55;
}

function getQualityPatternFallback(modelIdLower, flagshipDetected = false) {
  if (flagshipDetected) return 94;
  if (
    modelIdLower.includes('opus') ||
    modelIdLower.includes('gpt-5') ||
    modelIdLower.includes('o3') ||
    modelIdLower.includes('ultra') ||
    modelIdLower.includes('pro')
  ) {
    return 90;
  }
  if (
    modelIdLower.includes('sonnet') ||
    modelIdLower.includes('gpt-4') ||
    modelIdLower.includes('r1')
  ) {
    return 80;
  }
  return 66;
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
    toFiniteNumber(modelInfo?.top_provider?.context_length) ??
    toFiniteNumber(modelInfo?.architecture?.context_length) ??
    0
  );
}

function getMaxOutput(modelInfo = {}) {
  return (
    toFiniteNumber(modelInfo?.top_provider?.max_completion_tokens) ??
    toFiniteNumber(modelInfo?.max_completion_tokens) ??
    toFiniteNumber(modelInfo?.max_output_tokens) ??
    toFiniteNumber(modelInfo?.architecture?.max_completion_tokens) ??
    0
  );
}

function getTextSignals(modelInfo = {}) {
  return [
    modelInfo?.supported_parameters,
    modelInfo?.supportedParameters,
    modelInfo?.capabilities?.supported_parameters,
    modelInfo?.capabilities?.supportedParameters,
    modelInfo?.capabilities?.parameters,
    modelInfo?.architecture?.supported_parameters,
    modelInfo?.tags,
    Object.keys(modelInfo?.capabilities || {}),
  ]
    .flatMap((candidate) => {
      if (!candidate) return [];
      if (Array.isArray(candidate)) return candidate;
      if (typeof candidate === 'string') return candidate.split(',');
      if (typeof candidate === 'object') return Object.keys(candidate);
      return [];
    })
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function supportsImageInput(modelId, modelInfo = {}, capabilityRegistry = null) {
  const transportProvider = normalizeTransportProvider(modelId);
  const providerCapabilities = capabilityRegistry?.providers?.[transportProvider]?.capabilities || {};
  const hasProviderEntry = Boolean(capabilityRegistry?.providers && transportProvider in capabilityRegistry.providers);
  if (hasProviderEntry && providerCapabilities.imageInput === false) return false;
  if (transportProvider !== 'openrouter') return providerCapabilities.imageInput !== false;
  const imageSupport = getModelImageSupport(modelInfo);
  return imageSupport !== false;
}

function supportsNativeWebSearch(modelId, modelInfo = {}, capabilityRegistry = null) {
  const transportProvider = normalizeTransportProvider(modelId);
  const providerCapabilities = capabilityRegistry?.providers?.[transportProvider]?.capabilities || {};
  const hasProviderEntry = Boolean(capabilityRegistry?.providers && transportProvider in capabilityRegistry.providers);
  if (hasProviderEntry && providerCapabilities.webSearchNative === false) return false;
  if (transportProvider === 'openrouter') {
    return providerCapabilities.webSearchNative !== false;
  }

  const capabilityHints = getTextSignals(modelInfo);
  if (capabilityHints.some((hint) => (
    hint.includes('web_search') ||
    hint.includes('web-search') ||
    hint.includes('google_search') ||
    hint.includes('search_grounding')
  ))) {
    return true;
  }

  const modelIdLower = String(modelId || '').trim().toLowerCase();
  if (transportProvider === 'openai') return /\bsearch\b/.test(modelIdLower);
  if (transportProvider === 'anthropic') return /\bclaude[-./ ]?(3[-. ]?7|4)\b/.test(modelIdLower);
  if (transportProvider === 'gemini') return /\bgemini[-./ ]?(1\.5|2|2\.5)\b/.test(modelIdLower) || /\b(flash|pro)\b/.test(modelIdLower);
  return false;
}

function percentile(values, p = 0.5) {
  const safeValues = Array.isArray(values)
    ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  if (safeValues.length === 0) return null;
  const sorted = [...safeValues].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function scoreInverseLogScale(value, bestValue, worstValue, minScore = 25, maxScore = 100) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value <= bestValue) return maxScore;
  if (value >= worstValue) return minScore;
  const ratio = (Math.log(value) - Math.log(bestValue)) / (Math.log(worstValue) - Math.log(bestValue));
  return clamp(maxScore - ratio * (maxScore - minScore), minScore, maxScore);
}

function scoreLogScale(value, minValue, maxValue, minScore = 20, maxScore = 100) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value <= minValue) return minScore;
  if (value >= maxValue) return maxScore;
  const ratio = (Math.log(value) - Math.log(minValue)) / (Math.log(maxValue) - Math.log(minValue));
  return clamp(minScore + ratio * (maxScore - minScore), minScore, maxScore);
}

function getModelTelemetry(modelId, metrics, provider) {
  const modelMetrics = metrics?.modelStats && typeof metrics.modelStats === 'object'
    ? metrics.modelStats[getMetricsModelKey(modelId)] || null
    : null;
  const requestCount = Number(modelMetrics?.requestCount || 0);
  const successCount = Number(modelMetrics?.successCount || 0);
  const failureCount = Number(modelMetrics?.failureCount || 0);
  const retryAttempts = Number(modelMetrics?.retryAttempts || 0);
  const retryRecovered = Number(modelMetrics?.retryRecovered || 0);
  const cacheHits = Number(modelMetrics?.cacheHits || 0);
  const successfulTokenTotal = Number(modelMetrics?.successfulTokenTotal || 0);
  const firstTokenLatencies = Array.isArray(modelMetrics?.firstTokenLatencies)
    ? modelMetrics.firstTokenLatencies.filter((value) => Number.isFinite(Number(value)) && Number(value) >= 0).map(Number)
    : [];
  const durations = Array.isArray(modelMetrics?.durations)
    ? modelMetrics.durations.filter((value) => Number.isFinite(Number(value)) && Number(value) >= 0).map(Number)
    : [];
  const qualityVoteCount = Number(modelMetrics?.qualityVoteCount || 0);
  const judgeSignalWeightTotal = Number(modelMetrics?.judgeSignalWeightTotal || 0);
  const judgeRelativeWeightTotal = Number(modelMetrics?.judgeRelativeWeightTotal || 0);
  const judgeTopPlacementWeight = Number(modelMetrics?.judgeTopPlacementWeight || 0);
  const judgeOutlierWeight = Number(modelMetrics?.judgeOutlierWeight || 0);

  const globalRequestCount = Math.max(0, Number(metrics?.successCount || 0)) + Math.max(0, Number(metrics?.failureCount || 0));
  const globalSuccessRate = globalRequestCount > 0
    ? Number(metrics?.successCount || 0) / globalRequestCount
    : 0.86;
  const globalRetryRate = globalRequestCount > 0
    ? Number(metrics?.retryAttempts || 0) / globalRequestCount
    : 0.12;
  const providerFailures = Number(metrics?.failureByProvider?.[provider] || 0);
  const providerFailureRatio = providerFailures / Math.max(1, Number(metrics?.callCount || 0) || globalRequestCount || 1);
  const providerSuccessPrior = clamp(1 - providerFailureRatio * 2.5, 0.55, 0.97);
  const successPrior = (globalSuccessRate * 0.55) + (providerSuccessPrior * 0.45);
  const requestPriorWeight = 6;
  const retryPriorWeight = 4;
  const smoothedSuccessRate = (successCount + successPrior * requestPriorWeight) / (requestCount + requestPriorWeight);
  const smoothedRetryRate = (retryAttempts + globalRetryRate * retryPriorWeight) / (requestCount + retryPriorWeight);
  const cacheHitRate = requestCount > 0 ? cacheHits / requestCount : 0;
  const retryRecoveryRate = retryAttempts > 0 ? retryRecovered / retryAttempts : 0;
  const telemetryConfidence = clamp(Math.log2(1 + requestCount) / 4, 0, 1);
  const meanRelativeJudgeWeight = judgeSignalWeightTotal > 0
    ? judgeRelativeWeightTotal / judgeSignalWeightTotal
    : 1;
  const judgeTopPlacementRate = judgeSignalWeightTotal > 0
    ? judgeTopPlacementWeight / judgeSignalWeightTotal
    : 0;
  const judgeOutlierRate = judgeSignalWeightTotal > 0
    ? judgeOutlierWeight / judgeSignalWeightTotal
    : 0;
  const qualityTelemetryConfidence = clamp(Math.log2(1 + qualityVoteCount) / 3.5, 0, 1);

  return {
    requestCount,
    successCount,
    failureCount,
    retryAttempts,
    retryRecovered,
    cacheHits,
    successfulTokenTotal,
    successRate: smoothedSuccessRate,
    successRatePct: Math.round(smoothedSuccessRate * 100),
    retryRate: smoothedRetryRate,
    retryRatePct: Math.round(smoothedRetryRate * 100),
    cacheHitRate,
    cacheHitRatePct: Math.round(cacheHitRate * 100),
    retryRecoveryRate,
    telemetryConfidence,
    qualityVoteCount,
    judgeSignalWeightTotal,
    meanRelativeJudgeWeight,
    judgeTopPlacementRate,
    judgeTopPlacementRatePct: Math.round(judgeTopPlacementRate * 100),
    judgeOutlierRate,
    judgeOutlierRatePct: Math.round(judgeOutlierRate * 100),
    qualityTelemetryConfidence,
    p50FirstTokenMs: percentile(firstTokenLatencies, 0.5),
    p95FirstTokenMs: percentile(firstTokenLatencies, 0.95),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
  };
}

function getSpeedScore(modelIdLower, telemetry) {
  const fallback = getSpeedHeuristic(modelIdLower);
  const p50FirstTokenScore = scoreInverseLogScale(telemetry.p50FirstTokenMs, 450, 6500, 25, 100);
  const p95FirstTokenScore = scoreInverseLogScale(telemetry.p95FirstTokenMs, 900, 12000, 20, 100);
  const p50DurationScore = scoreInverseLogScale(telemetry.p50DurationMs, 2500, 30000, 25, 100);
  const measured = [
    Number.isFinite(p50FirstTokenScore) ? p50FirstTokenScore * 0.6 : 0,
    Number.isFinite(p95FirstTokenScore) ? p95FirstTokenScore * 0.15 : 0,
    Number.isFinite(p50DurationScore) ? p50DurationScore * 0.25 : 0,
  ].reduce((sum, value) => sum + value, 0);
  const hasMeasuredLatency = Number.isFinite(p50FirstTokenScore) || Number.isFinite(p50DurationScore);
  const cacheLift = telemetry.cacheHitRate * 8;
  return clamp(
    blendScores(fallback, hasMeasuredLatency ? measured + cacheLift : null, telemetry.telemetryConfidence),
    20,
    100,
  );
}

function getReliabilityScore(telemetry, metrics, provider) {
  const providerFailures = Number(metrics?.failureByProvider?.[provider] || 0);
  const providerFailureRatio = providerFailures / Math.max(1, Number(metrics?.callCount || 0) || (telemetry.requestCount + 1));
  const retryPenalty = telemetry.retryRate * 26;
  const providerPenalty = providerFailureRatio * 14;
  const recoveryBonus = telemetry.retryRecoveryRate * 6;
  const cacheBonus = telemetry.cacheHitRate * 4;
  return clamp((telemetry.successRate * 100) - retryPenalty - providerPenalty + recoveryBonus + cacheBonus, 22, 100);
}

function getHeuristicQualityScore(modelIdLower, modelInfo = {}, flagship = false, contextLength = 0, maxOutput = 0) {
  const tier = String(
    modelInfo?.tier ||
    modelInfo?.capabilities?.tier ||
    modelInfo?.top_provider?.tier ||
    ''
  ).toLowerCase();
  let score = 58;

  if (flagship) {
    score = 96;
  } else if (tier.includes('frontier') || tier.includes('state-of-the-art')) {
    score = 93;
  } else if (tier.includes('large') || tier.includes('premium')) {
    score = 84;
  }

  if (String(modelInfo?.description || '').toLowerCase().includes('reason')) {
    score += 3;
  }
  if (contextLength > 0) {
    score += clamp((Math.log2(contextLength) - 16) * 2.2, 0, 10);
  }
  if (maxOutput > 0) {
    score += clamp((Math.log2(maxOutput) - 12) * 3.2, 0, 10);
  }

  score = Math.max(score, getQualityPatternFallback(modelIdLower, flagship));
  return clamp(score, 40, 100);
}

function getEnsembleQualityFeedback(telemetry) {
  const voteCount = Number(telemetry?.qualityVoteCount || 0);
  if (voteCount <= 0) {
    return {
      score: null,
      confidence: 0,
      label: null,
      summary: null,
      voteCount: 0,
      meanRelativeJudgeWeight: 1,
      topPlacementRate: 0,
      outlierRate: 0,
    };
  }

  const meanRelativeJudgeWeight = clamp(Number(telemetry?.meanRelativeJudgeWeight || 1), 0.15, 3.5);
  const topPlacementRate = clamp(Number(telemetry?.judgeTopPlacementRate || 0), 0, 1);
  const outlierRate = clamp(Number(telemetry?.judgeOutlierRate || 0), 0, 1);
  const confidence = clamp(Number(telemetry?.qualityTelemetryConfidence || 0), 0, 1);
  const score = clamp(
    58 + (Math.log2(meanRelativeJudgeWeight) * 22) + (topPlacementRate * 14) - (outlierRate * 18),
    20,
    100,
  );
  const peerDeltaPct = Math.round((meanRelativeJudgeWeight - 1) * 100);
  const signedDelta = peerDeltaPct > 0 ? `+${peerDeltaPct}` : `${peerDeltaPct}`;
  const label = Math.abs(peerDeltaPct) < 6
    ? 'steady ensemble judge signal'
    : `judge ${signedDelta}% vs peer baseline`;
  const summary = `${signedDelta}% vs equal-share baseline across ${voteCount} ensemble eval${voteCount === 1 ? '' : 's'}`;

  return {
    score: roundToTenths(score),
    confidence,
    label,
    summary,
    voteCount,
    meanRelativeJudgeWeight: roundToTenths(meanRelativeJudgeWeight),
    topPlacementRate: roundToTenths(topPlacementRate * 100) / 100,
    outlierRate: roundToTenths(outlierRate * 100) / 100,
  };
}

function getModelCostEstimate(modelInfo, workloadProfile) {
  const pricing = getEstimatedModelPricingPerMillion(modelInfo);
  if (!pricing) {
    return { pricing: null, expectedCostUsd: null };
  }
  const safeWorkload = workloadProfile && typeof workloadProfile === 'object'
    ? workloadProfile
    : buildDebateParticipantWorkloadProfile();
  const inputTokens = Math.max(0, Number(safeWorkload.inputTokens || 0));
  const outputTokens = Math.max(0, Number(safeWorkload.outputTokens || 0));
  const expectedCostUsd = (
    (inputTokens * pricing.inputPerMillion) +
    (outputTokens * pricing.outputPerMillion)
  ) / 1_000_000;
  return { pricing, expectedCostUsd };
}

function getModelCostScore(expectedCostUsd) {
  if (expectedCostUsd == null) return 45;
  return roundToTenths(scoreInverseLogScale(expectedCostUsd, 0.004, 0.9, 0, 100) ?? 45);
}

function getCapabilityFit({
  modelId,
  modelInfo,
  capabilityRegistry,
  taskRequirements,
  contextLength,
  maxOutput,
}) {
  const requirements = taskRequirements && typeof taskRequirements === 'object' ? taskRequirements : null;
  const supportsImages = supportsImageInput(modelId, modelInfo, capabilityRegistry);
  const supportsSearch = supportsNativeWebSearch(modelId, modelInfo, capabilityRegistry);

  if (requirements?.requireImageInput && supportsImages === false) return null;
  if (requirements?.requireNativeWebSearch && supportsSearch === false) return null;
  if (
    Number.isFinite(Number(requirements?.minContextTokens)) &&
    Number(requirements.minContextTokens) > 0 &&
    Number.isFinite(contextLength) &&
    contextLength > 0 &&
    contextLength < Number(requirements.minContextTokens)
  ) {
    return null;
  }
  if (
    Number.isFinite(Number(requirements?.minOutputTokens)) &&
    Number(requirements.minOutputTokens) > 0 &&
    Number.isFinite(maxOutput) &&
    maxOutput > 0 &&
    maxOutput < Number(requirements.minOutputTokens)
  ) {
    return null;
  }

  let score = 55;
  const matched = [];
  const cautions = [];

  if (requirements?.preferImageInput) {
    if (supportsImages) {
      score += 18;
      matched.push('image-capable');
    } else if (supportsImages === false) {
      score -= 16;
      cautions.push('no native image input');
    }
  }

  if (requirements?.preferNativeWebSearch) {
    if (supportsSearch) {
      score += 16;
      matched.push('search-ready');
    } else if (supportsSearch === false) {
      score -= 14;
      cautions.push('no native web search');
    }
  }

  const preferredContext = Number(requirements?.preferContextTokens || 0);
  if (preferredContext > 0) {
    if (contextLength > 0) {
      const ratio = contextLength / preferredContext;
      if (ratio >= 1) {
        score += clamp(Math.log2(1 + ratio) * 10, 0, 15);
        matched.push(`keeps ${compactInteger(preferredContext)} context`);
      } else {
        score -= clamp(Math.log2(1 + (preferredContext / Math.max(1, contextLength))) * 13, 0, 18);
        cautions.push('smaller context window');
      }
    } else {
      score -= 8;
      cautions.push('unknown context window');
    }
  }

  const preferredOutput = Number(requirements?.preferOutputTokens || 0);
  if (preferredOutput > 0) {
    if (maxOutput > 0) {
      const ratio = maxOutput / preferredOutput;
      if (ratio >= 1) {
        score += clamp(Math.log2(1 + ratio) * 9, 0, 12);
        matched.push(`keeps ${compactInteger(preferredOutput)} output`);
      } else {
        score -= clamp(Math.log2(1 + (preferredOutput / Math.max(1, maxOutput))) * 11, 0, 14);
        cautions.push('lower max output');
      }
    } else {
      score -= 6;
      cautions.push('unknown max output');
    }
  }

  return {
    score: clamp(score, 10, 100),
    supportsImageInput: supportsImages,
    supportsNativeWebSearch: supportsSearch,
    matched,
    cautions,
  };
}

function getWeightsByMode(preferredMode) {
  const weightsByMode = {
    fast: { speed: 0.36, reliability: 0.22, cost: 0.18, quality: 0.08, context: 0.06, recency: 0.04, novelty: 0.02, flagship: 0.01, capability: 0.03 },
    quality: { speed: 0.06, reliability: 0.17, cost: 0.07, quality: 0.37, context: 0.11, recency: 0.08, novelty: 0.04, flagship: 0.05, capability: 0.05 },
    cheap: { speed: 0.10, reliability: 0.19, cost: 0.39, quality: 0.08, context: 0.08, recency: 0.04, novelty: 0.02, flagship: 0.01, capability: 0.09 },
    balanced: { speed: 0.18, reliability: 0.23, cost: 0.18, quality: 0.16, context: 0.09, recency: 0.05, novelty: 0.03, flagship: 0.02, capability: 0.06 },
    frontier: { speed: 0.04, reliability: 0.11, cost: 0.03, quality: 0.29, context: 0.05, recency: 0.21, novelty: 0.15, flagship: 0.08, capability: 0.04 },
  };
  return weightsByMode[preferredMode] || weightsByMode.balanced;
}

function getModelFamily(modelId, modelInfo = {}) {
  const text = [
    modelId,
    modelInfo?.name,
    modelInfo?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const patterns = [
    { pattern: /\bgpt[-\s]?5(\.[0-9]+)?\b/, family: 'gpt-5' },
    { pattern: /\bgpt[-\s]?4(\.[0-9]+|o)?\b/, family: 'gpt-4' },
    { pattern: /\bo3\b/, family: 'o3' },
    { pattern: /\bo1\b/, family: 'o1' },
    { pattern: /\bclaude[-\s]?4\b/, family: 'claude-4' },
    { pattern: /\bclaude[-\s]?3\.7\b/, family: 'claude-3.7' },
    { pattern: /\bgemini[-\s]?2\.5\b/, family: 'gemini-2.5' },
    { pattern: /\bgemini[-\s]?2\.0\b/, family: 'gemini-2.0' },
    { pattern: /\bllama[-\s]?4\b/, family: 'llama-4' },
    { pattern: /\bllama[-\s]?3\.3\b/, family: 'llama-3.3' },
    { pattern: /\bmistral[-\s]?large\b/, family: 'mistral-large' },
    { pattern: /\bcommand[-\s]?r\+\b/, family: 'command-r+' },
    { pattern: /\bdeepseek[-\s]?r1\b/, family: 'deepseek-r1' },
    { pattern: /\bgrok[-\s]?3\b/, family: 'grok-3' },
  ];
  for (const candidate of patterns) {
    if (candidate.pattern.test(text)) {
      return candidate.family;
    }
  }

  const catalogId = getMetricsModelKey(modelId);
  const withoutProvider = catalogId.includes('/') ? catalogId.split('/').slice(1).join('/') : catalogId;
  const familyTokens = withoutProvider.split(/[/:_-]+/).filter(Boolean).slice(0, 2);
  return familyTokens.join('-') || withoutProvider || catalogId || 'unknown';
}

function buildHighlights({
  signals,
  weights,
  telemetry,
  expectedCostUsd,
  contextLength,
  flagship,
  releasedAt,
  capabilityFit,
  benchmarkProfile,
  ensembleQuality,
}) {
  const qualityLabel = (
    (ensembleQuality?.confidence >= 0.45 && ensembleQuality?.label)
    || (benchmarkProfile?.confidence >= 0.4 && benchmarkProfile?.label)
    || (flagship ? 'flagship-tier quality' : 'strong quality profile')
  );
  const contributionMap = [
    {
      key: 'reliability',
      contribution: signals.reliability * weights.reliability,
      label: telemetry.requestCount > 0
        ? `success ${telemetry.successRatePct}%`
        : 'strong reliability',
    },
    {
      key: 'speed',
      contribution: signals.speed * weights.speed,
      label: telemetry.p50FirstTokenMs != null
        ? `p50 ${formatDurationMs(telemetry.p50FirstTokenMs)}`
        : 'fast response profile',
    },
    {
      key: 'cost',
      contribution: signals.cost * weights.cost,
      label: expectedCostUsd != null
        ? `${formatUsd(expectedCostUsd)} expected cost`
        : 'good cost profile',
    },
    {
      key: 'quality',
      contribution: signals.quality * weights.quality,
      label: qualityLabel,
    },
    {
      key: 'context',
      contribution: signals.context * weights.context,
      label: contextLength > 0 ? `${compactInteger(contextLength)} context` : 'healthy context window',
    },
    {
      key: 'recency',
      contribution: signals.recency * weights.recency,
      label: releasedAt ? 'recent release' : 'current model family',
    },
    {
      key: 'capability',
      contribution: signals.capability * weights.capability,
      label: capabilityFit?.matched?.[0] || 'good task fit',
    },
  ];
  return contributionMap
    .filter((item) => item.contribution > 4 && item.label)
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, 3)
    .map((item) => item.label);
}

function buildCautions({
  telemetry,
  expectedCostUsd,
  preview,
  capabilityFit,
  benchmarkProfile,
  ensembleQuality,
}) {
  const cautions = [];
  if (preview) cautions.push('preview model');
  if (telemetry.requestCount === 0) cautions.push('no direct telemetry yet');
  if (telemetry.p95FirstTokenMs != null && telemetry.p95FirstTokenMs > 8000) cautions.push('slow long-tail latency');
  if (expectedCostUsd != null && expectedCostUsd > 0.35) cautions.push('higher debate cost');
  if (benchmarkProfile?.confidence > 0 && benchmarkProfile.freshness < 0.62) cautions.push('stale benchmark snapshot');
  if (benchmarkProfile?.confidence > 0 && benchmarkProfile.coverage < 0.45) cautions.push('sparse benchmark coverage');
  if (ensembleQuality?.voteCount > 0 && ensembleQuality.outlierRate >= 0.35) cautions.push('often judged as an outlier');
  if (Array.isArray(capabilityFit?.cautions)) cautions.push(...capabilityFit.cautions);
  return cautions.slice(0, 3);
}

export function buildRankingTaskRequirements({
  currentModel = '',
  modelCatalog = {},
  attachments = [],
  webSearchEnabled = false,
} = {}) {
  const normalizedCurrentModel = getCatalogModelLookupId(currentModel);
  const currentModelInfo = normalizedCurrentModel ? modelCatalog?.[normalizedCurrentModel] || null : null;
  const imageAttachmentPresent = Array.isArray(attachments)
    && attachments.some((attachment) => String(attachment?.category || '').toLowerCase() === 'image');
  const preferredContextTokens = getContextLength(currentModelInfo || {});
  const preferredOutputTokens = getMaxOutput(currentModelInfo || {});

  if (!imageAttachmentPresent && !webSearchEnabled && preferredContextTokens <= 0 && preferredOutputTokens <= 0) {
    return null;
  }

  return {
    preferImageInput: imageAttachmentPresent,
    preferNativeWebSearch: Boolean(webSearchEnabled),
    preferContextTokens: preferredContextTokens > 0 ? preferredContextTokens : 0,
    preferOutputTokens: preferredOutputTokens > 0 ? preferredOutputTokens : 0,
  };
}

function getDefaultWorkloadProfile(workloadProfile) {
  if (workloadProfile && typeof workloadProfile === 'object') return workloadProfile;
  return buildDebateParticipantWorkloadProfile();
}

export function scoreModel({
  modelId,
  modelInfo,
  metrics,
  preferredMode = 'balanced',
  rankingPreferences = null,
  capabilityRegistry = null,
  taskRequirements = null,
  workloadProfile = null,
  nowMs = Date.now(),
}) {
  const normalizedPreferences = {
    preferFlagship: Boolean(rankingPreferences?.preferFlagship),
    preferNew: Boolean(rankingPreferences?.preferNew),
    allowPreview: rankingPreferences?.allowPreview !== false,
  };
  const preview = isPreviewModel(modelId, modelInfo);
  if (!normalizedPreferences.allowPreview && preview) {
    return null;
  }

  const normalizedModelId = getMetricsModelKey(modelId);
  const modelIdLower = String(modelId || '').toLowerCase();
  const provider = normalizeProvider(modelIdLower);
  const transportProvider = normalizeTransportProvider(modelId);
  const family = getModelFamily(modelId, modelInfo);
  const telemetry = getModelTelemetry(normalizedModelId, metrics, provider);
  const contextLength = getContextLength(modelInfo);
  const maxOutput = getMaxOutput(modelInfo);
  const capabilityFit = getCapabilityFit({
    modelId,
    modelInfo,
    capabilityRegistry,
    taskRequirements,
    contextLength,
    maxOutput,
  });
  if (!capabilityFit) return null;

  const flagship = isFlagshipModel(modelId, modelInfo);
  const heuristicQualityScore = getHeuristicQualityScore(modelIdLower, modelInfo, flagship, contextLength, maxOutput);
  const benchmarkProfile = resolveModelBenchmarkProfile({
    modelId: normalizedModelId,
    modelInfo,
    taskRequirements,
    preferredMode,
    nowMs,
  });
  const ensembleQuality = getEnsembleQualityFeedback(telemetry);
  const qualityFromBenchmarks = blendScores(
    heuristicQualityScore,
    benchmarkProfile.score,
    benchmarkProfile.confidence,
  );
  const qualityScore = blendScores(
    qualityFromBenchmarks,
    ensembleQuality.score,
    ensembleQuality.confidence,
  );
  const speedScore = getSpeedScore(modelIdLower, telemetry);
  const reliabilityScore = getReliabilityScore(telemetry, metrics, provider);
  const { pricing, expectedCostUsd } = getModelCostEstimate(modelInfo, getDefaultWorkloadProfile(workloadProfile));
  const costScore = getModelCostScore(expectedCostUsd);
  const contextScore = scoreLogScale(contextLength, 16_384, 2_000_000, 20, 100) ?? 40;
  const releasedAt = getModelReleaseTimestampMs(modelInfo);
  const recencyScore = getRecencyScore(releasedAt, nowMs);
  const noveltyScore = getReleaseNoveltyScore(releasedAt, nowMs);
  const flagshipScore = flagship ? 100 : 48;
  const capabilityScore = capabilityFit.score;
  const weights = getWeightsByMode(preferredMode);

  let total = (
    speedScore * weights.speed +
    reliabilityScore * weights.reliability +
    costScore * weights.cost +
    qualityScore * weights.quality +
    contextScore * weights.context +
    recencyScore * weights.recency +
    noveltyScore * weights.novelty +
    flagshipScore * weights.flagship +
    capabilityScore * weights.capability
  );

  if (normalizedPreferences.preferFlagship && flagship) {
    total += 6.5;
  }
  if (normalizedPreferences.preferNew) {
    total += (recencyScore - 50) * 0.08;
    total += (noveltyScore - 50) * 0.08;
  }
  if (preview && preferredMode !== 'frontier') {
    total -= 2.5;
  } else if (preview && preferredMode === 'frontier') {
    total += 1.5;
  }
  total = clamp(total, 0, 100);

  const signals = {
    speed: roundToTenths(speedScore),
    reliability: roundToTenths(reliabilityScore),
    cost: roundToTenths(costScore),
    quality: roundToTenths(qualityScore),
    context: roundToTenths(contextScore),
    recency: roundToTenths(recencyScore),
    novelty: roundToTenths(noveltyScore),
    flagship: roundToTenths(flagshipScore),
    capability: roundToTenths(capabilityScore),
  };

  return {
    modelId,
    normalizedModelId,
    family,
    provider,
    transportProvider,
    score: roundToTenths(total),
    pricing,
    expectedCostUsd: expectedCostUsd != null ? roundToTenths(expectedCostUsd * 1000) / 1000 : null,
    isFlagship: flagship,
    isPreview: preview,
    releasedAt,
    telemetry,
    qualityBreakdown: {
      heuristicScore: roundToTenths(heuristicQualityScore),
      benchmark: benchmarkProfile,
      feedback: ensembleQuality,
      finalScore: roundToTenths(qualityScore),
    },
    capabilities: {
      imageInput: capabilityFit.supportsImageInput,
      nativeWebSearch: capabilityFit.supportsNativeWebSearch,
      contextLength,
      maxOutput,
    },
    signals,
    highlights: buildHighlights({
      signals,
      weights,
      telemetry,
      expectedCostUsd,
      contextLength,
      flagship,
      releasedAt,
      capabilityFit,
      benchmarkProfile,
      ensembleQuality,
    }),
    cautions: buildCautions({
      telemetry,
      expectedCostUsd,
      preview,
      capabilityFit,
      benchmarkProfile,
      ensembleQuality,
    }),
  };
}

export function rankModels({
  modelCatalog = {},
  metrics = null,
  preferredMode = 'balanced',
  limit = 8,
  rankingPreferences = null,
  capabilityRegistry = null,
  taskRequirements = null,
  workloadProfile = null,
  nowMs = Date.now(),
}) {
  const ranked = Object.entries(modelCatalog)
    .map(([modelId, modelInfo]) => scoreModel({
      modelId,
      modelInfo,
      metrics,
      preferredMode,
      rankingPreferences,
      capabilityRegistry,
      taskRequirements,
      workloadProfile,
      nowMs,
    }))
    .filter(Boolean)
    .sort((left, right) => (
      right.score - left.score
      || right.telemetry.requestCount - left.telemetry.requestCount
      || right.signals.quality - left.signals.quality
    ));
  if (!Number.isFinite(limit) || limit <= 0) return ranked;
  return ranked.slice(0, limit);
}

function normalizeIdSet(modelIds = []) {
  return new Set(
    (Array.isArray(modelIds) ? modelIds : [])
      .map((modelId) => getMetricsModelKey(modelId))
      .filter(Boolean)
  );
}

export function rerankModelsForDiversity({
  rankedModels = [],
  selectedModelIds = [],
  currentModelId = '',
} = {}) {
  const selectedIds = normalizeIdSet(selectedModelIds);
  const currentId = getMetricsModelKey(currentModelId);
  const selectedProviders = new Set();
  const selectedFamilies = new Set();
  const selectedLookup = new Map();

  for (const entry of rankedModels) {
    selectedLookup.set(getMetricsModelKey(entry.modelId), entry);
  }
  for (const modelId of selectedIds) {
    const entry = selectedLookup.get(modelId);
    selectedProviders.add(entry?.provider || normalizeProvider(modelId));
    selectedFamilies.add(entry?.family || getModelFamily(modelId));
  }

  const currentEntry = currentId ? selectedLookup.get(currentId) : null;
  const currentProvider = currentEntry?.provider || normalizeProvider(currentModelId);
  const currentFamily = currentEntry?.family || null;

  return (Array.isArray(rankedModels) ? rankedModels : [])
    .map((entry) => {
      const normalizedId = getMetricsModelKey(entry.modelId);
      const alreadySelected = selectedIds.has(normalizedId);
      const providerRepeated = selectedProviders.has(entry.provider);
      const familyRepeated = selectedFamilies.has(entry.family);
      const sameProviderAsCurrent = Boolean(currentProvider) && entry.provider === currentProvider;
      const sameFamilyAsCurrent = Boolean(currentFamily) && entry.family === currentFamily;
      let penalty = 0;
      if (alreadySelected) penalty += 18;
      if (providerRepeated) penalty += 8;
      if (familyRepeated) penalty += 6;
      if (!providerRepeated && sameProviderAsCurrent) penalty += 4;
      if (!familyRepeated && sameFamilyAsCurrent) penalty += 3;
      return {
        ...entry,
        adjustedScore: roundToTenths(entry.score - penalty),
        diversity: {
          alreadySelected,
          providerRepeated,
          familyRepeated,
          sameProviderAsCurrent,
          sameFamilyAsCurrent,
        },
      };
    })
    .sort((left, right) => (
      right.adjustedScore - left.adjustedScore
      || right.score - left.score
      || right.telemetry.requestCount - left.telemetry.requestCount
    ));
}

export function selectDiverseModels({
  rankedModels = [],
  count = 3,
} = {}) {
  const safeCount = Math.max(1, Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 1);
  const remaining = Array.isArray(rankedModels) ? [...rankedModels] : [];
  const selected = [];
  let selectedIds = [];

  while (selected.length < safeCount && remaining.length > 0) {
    const reranked = rerankModelsForDiversity({
      rankedModels: remaining,
      selectedModelIds: selectedIds,
    });
    const next = reranked[0];
    if (!next) break;
    selected.push(next);
    selectedIds = selected.map((entry) => entry.modelId);
    const normalizedNextId = getMetricsModelKey(next.modelId);
    const nextIndex = remaining.findIndex((entry) => getMetricsModelKey(entry.modelId) === normalizedNextId);
    if (nextIndex >= 0) {
      remaining.splice(nextIndex, 1);
    } else {
      remaining.shift();
    }
  }

  return selected;
}
