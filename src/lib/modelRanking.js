function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const MODEL_FIRST_SEEN_STORAGE_KEY = 'smart_ranking_first_seen_v1';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function loadFirstSeenMap() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(MODEL_FIRST_SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([modelId, value]) => [modelId, Number(value)])
        .filter(([, value]) => Number.isFinite(value) && value > 0)
    );
  } catch {
    return {};
  }
}

function saveFirstSeenMap(map) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MODEL_FIRST_SEEN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage limits and private mode restrictions
  }
}

function getCatalogFirstSeenSnapshot(modelCatalog = {}, nowMs = Date.now()) {
  const known = loadFirstSeenMap();
  let changed = false;
  for (const modelId of Object.keys(modelCatalog || {})) {
    if (!known[modelId]) {
      known[modelId] = nowMs;
      changed = true;
    }
  }
  if (changed) saveFirstSeenMap(known);
  return known;
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
  if (!releasedAtMs || !Number.isFinite(releasedAtMs)) return 52;
  const ageDays = Math.max(0, (nowMs - releasedAtMs) / ONE_DAY_MS);
  return clamp(100 - Math.log2(1 + ageDays) * 6, 35, 100);
}

function getNoveltyScore(firstSeenAtMs, nowMs = Date.now()) {
  if (!firstSeenAtMs || !Number.isFinite(firstSeenAtMs)) return 50;
  const ageDays = Math.max(0, (nowMs - firstSeenAtMs) / ONE_DAY_MS);
  return clamp(100 - Math.log2(1 + ageDays) * 10, 25, 100);
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

function getQualityHeuristic(modelIdLower, flagshipDetected = false) {
  if (flagshipDetected) return 93;
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
    toFiniteNumber(modelInfo?.architecture?.context_length) ??
    0
  );
}

export function scoreModel({
  modelId,
  modelInfo,
  metrics,
  preferredMode = 'balanced',
  modelFirstSeenAt = null,
  rankingPreferences = null,
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
  const totalCalls = Number(metrics?.callCount || 0);
  const failureRatio = providerFailures / Math.max(1, totalCalls);
  const reliabilityPenalty = Math.log2(1 + providerFailures) * 9 + failureRatio * 240;
  const reliabilityScore = clamp(100 - reliabilityPenalty, 30, 100);

  const flagship = isFlagshipModel(modelId, modelInfo);
  const speedHeuristic = getSpeedHeuristic(modelIdLower);
  const qualityHeuristic = getQualityHeuristic(modelIdLower, flagship);
  const releasedAt = getModelReleaseTimestampMs(modelInfo);
  const recencyScore = getRecencyScore(releasedAt, nowMs);
  const noveltyScore = getNoveltyScore(modelFirstSeenAt, nowMs);
  const flagshipScore = flagship ? 100 : 45;

  const weightsByMode = {
    fast: { speed: 0.4, reliability: 0.2, cost: 0.2, quality: 0.08, context: 0.07, recency: 0.03, novelty: 0.01, flagship: 0.01 },
    quality: { speed: 0.07, reliability: 0.17, cost: 0.08, quality: 0.4, context: 0.11, recency: 0.08, novelty: 0.04, flagship: 0.05 },
    cheap: { speed: 0.12, reliability: 0.2, cost: 0.42, quality: 0.09, context: 0.1, recency: 0.04, novelty: 0.02, flagship: 0.01 },
    balanced: { speed: 0.22, reliability: 0.24, cost: 0.19, quality: 0.16, context: 0.1, recency: 0.05, novelty: 0.02, flagship: 0.02 },
    frontier: { speed: 0.04, reliability: 0.1, cost: 0.03, quality: 0.34, context: 0.04, recency: 0.22, novelty: 0.13, flagship: 0.1 },
  };
  const weights = weightsByMode[preferredMode] || weightsByMode.balanced;

  let total = (
    speedHeuristic * weights.speed +
    reliabilityScore * weights.reliability +
    costScore * weights.cost +
    qualityHeuristic * weights.quality +
    contextScore * weights.context +
    recencyScore * weights.recency +
    noveltyScore * weights.novelty +
    flagshipScore * weights.flagship
  );
  if (normalizedPreferences.preferFlagship && flagship) {
    total += 7;
  }
  if (normalizedPreferences.preferNew) {
    total += (recencyScore - 50) * 0.08;
    total += (noveltyScore - 50) * 0.06;
  }
  if (preview && preferredMode !== 'frontier') {
    total -= 1.5;
  } else if (preview && preferredMode === 'frontier') {
    total += 2;
  }
  total = clamp(total, 0, 100);

  return {
    modelId,
    score: Math.round(total * 10) / 10,
    provider,
    pricing,
    isFlagship: flagship,
    isPreview: preview,
    releasedAt,
    firstSeenAt: modelFirstSeenAt || null,
    signals: {
      speed: speedHeuristic,
      reliability: reliabilityScore,
      cost: costScore,
      quality: qualityHeuristic,
      context: contextScore,
      recency: recencyScore,
      novelty: noveltyScore,
      flagship: flagshipScore,
    },
  };
}

export function rankModels({
  modelCatalog = {},
  metrics = null,
  preferredMode = 'balanced',
  limit = 8,
  rankingPreferences = null,
}) {
  const nowMs = Date.now();
  const firstSeenSnapshot = getCatalogFirstSeenSnapshot(modelCatalog, nowMs);
  const ranked = Object.entries(modelCatalog)
    .map(([modelId, modelInfo]) => scoreModel({
      modelId,
      modelInfo,
      metrics,
      preferredMode,
      modelFirstSeenAt: firstSeenSnapshot[modelId] || null,
      rankingPreferences,
      nowMs,
    }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  if (!Number.isFinite(limit) || limit <= 0) return ranked;
  return ranked.slice(0, limit);
}
