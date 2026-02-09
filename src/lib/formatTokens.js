function toFiniteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const COST_QUALITY = {
  NONE: 'none',
  EXACT: 'exact',
  ESTIMATED: 'estimated',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
};

const TOKENS_PER_MILLION = 1_000_000;
const LOCAL_STORAGE_PRICING_KEY = 'model_pricing_fallbacks';

let pricingCacheKey = null;
let pricingCache = {};

/**
 * Format a token count for display.
 * "847" or "1.2k" or "12.5k"
 */
export function formatTokenCount(count) {
  const value = toFiniteNumber(count);
  if (value == null) return null;
  if (value < 1000) return String(Math.round(value));
  return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

/**
 * Format a USD cost for display.
 * "$0.0012" or "$0.05" or "$1.23"
 */
export function formatCost(cost) {
  const value = toFiniteNumber(cost);
  if (value == null) return null;
  if (value === 0) return '$0.00';
  if (value < 0.001) return '<$0.001';
  if (value < 0.01) return '$' + value.toFixed(4);
  if (value < 1) return '$' + value.toFixed(3);
  return '$' + value.toFixed(2);
}

function parsePricingEntry(entry) {
  if (entry == null) return null;

  if (typeof entry === 'number' || typeof entry === 'string') {
    const rate = toFiniteNumber(entry);
    if (rate == null || rate < 0) return null;
    return { inputPerMillion: rate, outputPerMillion: rate };
  }

  if (typeof entry !== 'object') return null;

  const inputPerMillion = toFiniteNumber(
    entry.inputPerMillion
    ?? entry.inputPer1M
    ?? entry.promptPerMillion
    ?? entry.promptPer1M
    ?? entry.input
    ?? entry.prompt
  );
  const outputPerMillion = toFiniteNumber(
    entry.outputPerMillion
    ?? entry.outputPer1M
    ?? entry.completionPerMillion
    ?? entry.completionPer1M
    ?? entry.output
    ?? entry.completion
  );

  const input = inputPerMillion != null ? inputPerMillion : outputPerMillion;
  const output = outputPerMillion != null ? outputPerMillion : inputPerMillion;

  if (input == null || output == null || input < 0 || output < 0) return null;
  return { inputPerMillion: input, outputPerMillion: output };
}

function parsePricingMap(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    const source = parsed && typeof parsed.models === 'object' ? parsed.models : parsed;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

    const map = {};
    for (const [key, value] of Object.entries(source)) {
      if (!key || typeof key !== 'string') continue;
      const pricing = parsePricingEntry(value);
      if (!pricing) continue;
      map[key.trim()] = pricing;
    }
    return map;
  } catch {
    return {};
  }
}

function getLocalPricingRaw() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage?.getItem(LOCAL_STORAGE_PRICING_KEY) || '';
  } catch {
    return '';
  }
}

function getPricingFallbacks() {
  const envRaw = import.meta.env?.VITE_MODEL_PRICING_FALLBACKS || '';
  const localRaw = getLocalPricingRaw();
  const cacheKey = `${envRaw}:::${localRaw}`;
  if (cacheKey === pricingCacheKey) return pricingCache;

  pricingCacheKey = cacheKey;
  pricingCache = {
    ...parsePricingMap(envRaw),
    ...parsePricingMap(localRaw),
  };
  return pricingCache;
}

function resolvePricingForModel(model, pricingMap) {
  if (!pricingMap || typeof pricingMap !== 'object') return null;
  if (model && pricingMap[model]) return pricingMap[model];

  const defaultPricing = pricingMap.default || null;
  if (!model) return defaultPricing;

  let bestMatch = null;
  let bestLength = -1;

  for (const [pattern, pricing] of Object.entries(pricingMap)) {
    if (!pricing || pattern === 'default') continue;
    const isWildcard = pattern.endsWith('*');
    const isPrefix = pattern.endsWith('/');
    if (!isWildcard && !isPrefix) continue;

    const prefix = isWildcard ? pattern.slice(0, -1) : pattern;
    if (!prefix) continue;
    if (!model.startsWith(prefix)) continue;
    if (prefix.length > bestLength) {
      bestLength = prefix.length;
      bestMatch = pricing;
    }
  }

  return bestMatch || defaultPricing;
}

function hasUsageSignals(usage) {
  if (!usage || typeof usage !== 'object') return false;
  return (
    toFiniteNumber(usage.cost) != null
    || toFiniteNumber(usage.promptTokens) != null
    || toFiniteNumber(usage.completionTokens) != null
    || toFiniteNumber(usage.totalTokens) != null
  );
}

function combineCostQualities(qualities) {
  if (!qualities || qualities.length === 0) return COST_QUALITY.NONE;

  const hasExact = qualities.includes(COST_QUALITY.EXACT);
  const hasEstimated = qualities.includes(COST_QUALITY.ESTIMATED);
  const hasPartial = qualities.includes(COST_QUALITY.PARTIAL);
  const hasUnknown = qualities.includes(COST_QUALITY.UNKNOWN);

  if (hasPartial) return COST_QUALITY.PARTIAL;
  if (hasUnknown && (hasExact || hasEstimated)) return COST_QUALITY.PARTIAL;
  if (hasUnknown) return COST_QUALITY.UNKNOWN;
  if (hasEstimated) return COST_QUALITY.ESTIMATED;
  if (hasExact) return COST_QUALITY.EXACT;
  return COST_QUALITY.NONE;
}

function deriveTokenBreakdown(usage) {
  let promptTokens = toFiniteNumber(usage?.promptTokens);
  let completionTokens = toFiniteNumber(usage?.completionTokens);
  const totalTokens = toFiniteNumber(usage?.totalTokens);

  if (promptTokens == null && completionTokens != null && totalTokens != null && totalTokens >= completionTokens) {
    promptTokens = totalTokens - completionTokens;
  }
  if (completionTokens == null && promptTokens != null && totalTokens != null && totalTokens >= promptTokens) {
    completionTokens = totalTokens - promptTokens;
  }

  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Returns a normalized cost object for a usage payload:
 * { cost, quality } where quality is exact|estimated|partial|unknown|none
 */
export function getUsageCostMeta(usage, model = '') {
  if (!hasUsageSignals(usage)) {
    return { cost: 0, quality: COST_QUALITY.NONE };
  }

  const exactCost = toFiniteNumber(usage?.cost);
  if (exactCost != null && exactCost >= 0) {
    return { cost: exactCost, quality: COST_QUALITY.EXACT };
  }

  const pricing = resolvePricingForModel(model, getPricingFallbacks());
  if (!pricing) {
    return { cost: 0, quality: COST_QUALITY.UNKNOWN };
  }

  const { promptTokens, completionTokens, totalTokens } = deriveTokenBreakdown(usage);
  const hasPrompt = promptTokens != null;
  const hasCompletion = completionTokens != null;
  const hasTotal = totalTokens != null;

  if (!hasPrompt && !hasCompletion) {
    if (hasTotal && pricing.inputPerMillion === pricing.outputPerMillion) {
      const estimated = (totalTokens * pricing.inputPerMillion) / TOKENS_PER_MILLION;
      return { cost: estimated, quality: COST_QUALITY.ESTIMATED };
    }
    return { cost: 0, quality: COST_QUALITY.UNKNOWN };
  }

  const promptCost = hasPrompt ? (promptTokens * pricing.inputPerMillion) / TOKENS_PER_MILLION : 0;
  const completionCost = hasCompletion ? (completionTokens * pricing.outputPerMillion) / TOKENS_PER_MILLION : 0;
  const estimated = promptCost + completionCost;

  const missingSomeTokens = !(hasPrompt && hasCompletion);
  return {
    cost: estimated,
    quality: missingSomeTokens ? COST_QUALITY.PARTIAL : COST_QUALITY.ESTIMATED,
  };
}

/**
 * Aggregate a list of cost metadata objects.
 * Each item can be { cost, quality } or { totalCost, quality }.
 */
export function aggregateCostMetas(metas) {
  if (!Array.isArray(metas) || metas.length === 0) {
    return { totalCost: 0, quality: COST_QUALITY.NONE };
  }

  let totalCost = 0;
  const qualities = [];

  for (const meta of metas) {
    if (!meta) continue;
    const cost = toFiniteNumber(meta.totalCost ?? meta.cost);
    if (cost != null) totalCost += cost;
    if (meta.quality && meta.quality !== COST_QUALITY.NONE) {
      qualities.push(meta.quality);
    }
  }

  return {
    totalCost,
    quality: combineCostQualities(qualities),
  };
}

/**
 * Aggregate round cost (streams + convergence check).
 */
export function computeRoundCostMeta(round) {
  if (!round) return { totalCost: 0, quality: COST_QUALITY.NONE };
  const metas = [];

  if (Array.isArray(round.streams)) {
    for (const stream of round.streams) {
      metas.push(getUsageCostMeta(stream?.usage, stream?.model || ''));
    }
  }
  if (round.convergenceCheck) {
    metas.push(getUsageCostMeta(round.convergenceCheck.usage, round.convergenceCheck.model || ''));
  }

  return aggregateCostMetas(metas);
}

/**
 * Aggregate a turn's cost with quality metadata.
 */
export function computeTurnCostMeta(turn) {
  if (!turn || typeof turn !== 'object') {
    return { totalCost: 0, quality: COST_QUALITY.NONE };
  }

  const metas = [];

  if (Array.isArray(turn.rounds)) {
    for (const round of turn.rounds) {
      metas.push(computeRoundCostMeta(round));
    }
  }

  metas.push(getUsageCostMeta(turn.synthesis?.usage, turn.synthesis?.model || ''));
  metas.push(getUsageCostMeta(turn.ensembleResult?.usage, turn.ensembleResult?.model || ''));
  metas.push(getUsageCostMeta(turn.webSearchResult?.usage, turn.webSearchResult?.model || ''));

  return aggregateCostMetas(metas);
}

/**
 * Aggregate a conversation's cost with quality metadata.
 */
export function computeConversationCostMeta(conversation) {
  if (!conversation?.turns || !Array.isArray(conversation.turns) || conversation.turns.length === 0) {
    return { totalCost: 0, quality: COST_QUALITY.NONE };
  }

  return aggregateCostMetas(conversation.turns.map(computeTurnCostMeta));
}

/**
 * Human-friendly cost string that includes quality markers.
 * exact -> "$0.12", estimated -> "~$0.12", partial -> "$0.12+", unknown -> "Unknown"
 */
export function formatCostWithQuality(meta, options = {}) {
  const includeUnknown = options.includeUnknown ?? true;
  const quality = meta?.quality || COST_QUALITY.NONE;
  if (quality === COST_QUALITY.NONE) return null;
  if (quality === COST_QUALITY.UNKNOWN) return includeUnknown ? 'Unknown' : null;

  const value = toFiniteNumber(meta?.totalCost ?? meta?.cost);
  const base = formatCost(value);
  if (!base) return null;

  if (quality === COST_QUALITY.ESTIMATED) return `~${base}`;
  if (quality === COST_QUALITY.PARTIAL) return `${base}+`;
  return base;
}

/**
 * Tooltip copy for cost quality labels.
 */
export function getCostQualityDescription(quality) {
  if (quality === COST_QUALITY.EXACT) return 'Provider-reported cost';
  if (quality === COST_QUALITY.ESTIMATED) return 'Estimated using fallback token pricing';
  if (quality === COST_QUALITY.PARTIAL) return 'Partially estimated; some cost inputs were missing';
  if (quality === COST_QUALITY.UNKNOWN) return 'Cost unavailable (missing pricing or usage details)';
  return '';
}

/**
 * Aggregate cost from all streams and synthesis in a turn.
 */
export function computeTurnCost(turn) {
  return computeTurnCostMeta(turn).totalCost;
}

/**
 * Aggregate cost from all turns in a conversation.
 */
export function computeConversationCost(conversation) {
  return computeConversationCostMeta(conversation).totalCost;
}

/**
 * Format a duration in milliseconds for display.
 * "340ms" or "3.4s" or "1m 12s"
 */
export function formatDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
