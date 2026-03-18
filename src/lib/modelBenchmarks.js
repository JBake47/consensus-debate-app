import { getCatalogModelLookupId } from './modelStats.js';

const CURATED_BENCHMARK_SNAPSHOT_AT = '2026-03-18T00:00:00Z';
const SCALE_LEADERBOARD_URL = 'https://labs.scale.com/leaderboard';
const AIDER_LEADERBOARD_URL = 'https://aider.chat/docs/leaderboards/';

const BENCHMARK_SUITE_META = {
  humanitys_last_exam: {
    label: "Humanity's Last Exam",
    category: 'reasoning',
    sourceQuality: 0.98,
    min: 0,
    max: 40,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  professional_reasoning_finance: {
    label: 'Professional Reasoning Benchmark - Finance',
    category: 'reasoning',
    sourceQuality: 0.97,
    min: 0,
    max: 60,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  professional_reasoning_legal: {
    label: 'Professional Reasoning Benchmark - Legal',
    category: 'reasoning',
    sourceQuality: 0.97,
    min: 0,
    max: 60,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  swe_atlas_qna: {
    label: 'SWE Atlas - Codebase QnA',
    category: 'coding',
    sourceQuality: 0.97,
    min: 0,
    max: 40,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  swe_bench_pro_public: {
    label: 'SWE-Bench Pro (Public)',
    category: 'coding',
    sourceQuality: 0.96,
    min: 0,
    max: 50,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  swe_bench_pro_private: {
    label: 'SWE-Bench Pro (Private)',
    category: 'coding',
    sourceQuality: 0.96,
    min: 0,
    max: 30,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  mcp_atlas: {
    label: 'MCP Atlas',
    category: 'instruction',
    sourceQuality: 0.95,
    min: 0,
    max: 70,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  visualtoolbench: {
    label: 'VisualToolBench',
    category: 'multimodal',
    sourceQuality: 0.95,
    min: 0,
    max: 30,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  multichallenge: {
    label: 'MultiChallenge',
    category: 'chat',
    sourceQuality: 0.94,
    min: 0,
    max: 70,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  multinrc: {
    label: 'MultiNRC',
    category: 'reasoning',
    sourceQuality: 0.93,
    min: 0,
    max: 70,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  enigmaeval: {
    label: 'EnigmaEval',
    category: 'reasoning',
    sourceQuality: 0.92,
    min: 0,
    max: 25,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  scipredict: {
    label: 'SciPredict',
    category: 'reasoning',
    sourceQuality: 0.92,
    min: 0,
    max: 30,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  vista: {
    label: 'VISTA',
    category: 'multimodal',
    sourceQuality: 0.92,
    min: 0,
    max: 60,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  tutorbench: {
    label: 'TutorBench',
    category: 'instruction',
    sourceQuality: 0.9,
    min: 0,
    max: 60,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: CURATED_BENCHMARK_SNAPSHOT_AT,
    sourceLabel: 'Scale Labs leaderboard snapshot',
    sourceUrl: SCALE_LEADERBOARD_URL,
  },
  aider_polyglot: {
    label: 'Aider Polyglot',
    category: 'coding',
    sourceQuality: 0.86,
    min: 0,
    max: 100,
    cadence: 'rolling',
    maxAgeDays: 120,
    updatedAt: '2025-08-25T00:00:00Z',
    sourceLabel: 'Aider leaderboard',
    sourceUrl: AIDER_LEADERBOARD_URL,
  },
};

const CURATED_BENCHMARK_PRIORS = [
  {
    key: 'gpt-5.4-codex',
    patterns: [/\bgpt[-/.\s]?5\.?4\b.*\bcodex\b/i],
    suites: {
      swe_atlas_qna: 35.48,
    },
  },
  {
    key: 'gpt-5.2',
    patterns: [/\bgpt[-/.\s]?5\.?2\b/i],
    suites: {
      swe_atlas_qna: 29.03,
      mcp_atlas: 60.57,
      swe_bench_pro_private: 23.81,
    },
  },
  {
    key: 'gpt-5.1-thinking',
    patterns: [/\bgpt[-/.\s]?5\.?1\b.*\bthinking\b/i],
    suites: {
      multichallenge: 63.41,
    },
  },
  {
    key: 'gpt-5-pro',
    exactIds: ['openai/gpt-5-pro'],
    patterns: [/\bgpt[-/.\s]?5\b.*\bpro\b/i],
    suites: {
      humanitys_last_exam: 31.64,
      professional_reasoning_finance: 51.06,
      professional_reasoning_legal: 49.89,
      multinrc: 65.20,
      enigmaeval: 18.75,
      vista: 52.39,
    },
  },
  {
    key: 'gpt-5-thinking',
    patterns: [/\bgpt[-/.\s]?5\b.*\bthinking\b/i],
    suites: {
      visualtoolbench: 18.68,
      multichallenge: 63.19,
    },
  },
  {
    key: 'gpt-5',
    exactIds: ['openai/gpt-5'],
    patterns: [/\bgpt[-/.\s]?5\b/i],
    suites: {
      professional_reasoning_finance: 51.32,
      visualtoolbench: 16.96,
      tutorbench: 55.33,
    },
  },
  {
    key: 'claude-opus-4.6-thinking',
    patterns: [
      /\bclaude[-/.\s]?opus[-/.\s]?4[-/.\s]?6\b.*\bthinking\b/i,
      /\bclaude[-/.\s]?opus[-/.\s]?4[-/.\s]?6\b.*\bmax\b/i,
      /\bclaude[-/.\s]?4[-/.\s]?6\b.*\bopus\b.*\bthinking\b/i,
    ],
    suites: {
      humanitys_last_exam: 34.44,
      swe_atlas_qna: 31.5,
      multinrc: 57.06,
    },
  },
  {
    key: 'claude-opus-4.6',
    patterns: [
      /\bclaude[-/.\s]?opus[-/.\s]?4[-/.\s]?6\b/i,
      /\bclaude[-/.\s]?4[-/.\s]?6\b.*\bopus\b/i,
    ],
    suites: {
      professional_reasoning_finance: 53.28,
      professional_reasoning_legal: 52.27,
    },
  },
  {
    key: 'claude-opus-4.5',
    patterns: [/\bclaude[-/.\s]?opus[-/.\s]?4[-/.\s]?5\b/i],
    suites: {
      mcp_atlas: 62.3,
      swe_bench_pro_public: 45.89,
      swe_bench_pro_private: 23.44,
      scipredict: 23.05,
    },
  },
  {
    key: 'claude-4.5-sonnet',
    patterns: [/\bclaude[-/.\s]?4[-/.\s]?5\b.*\bsonnet\b/i],
    suites: {
      swe_bench_pro_public: 43.6,
    },
  },
  {
    key: 'gemini-3-pro-preview',
    exactIds: ['google/gemini-3-pro-preview'],
    patterns: [/\bgemini[-/.\s]?3\b.*\bpro\b.*\bpreview\b/i],
    suites: {
      humanitys_last_exam: 37.52,
      swe_bench_pro_public: 43.3,
      scipredict: 25.27,
      visualtoolbench: 26.85,
      multichallenge: 65.67,
      multinrc: 58.96,
      enigmaeval: 18.24,
    },
  },
  {
    key: 'gemini-3-flash-preview',
    patterns: [/\bgemini[-/.\s]?3\b.*\bflash\b.*\bpreview\b/i],
    suites: {
      mcp_atlas: 57.4,
    },
  },
  {
    key: 'gemini-2.5-pro',
    exactIds: ['google/gemini-2.5-pro', 'google/gemini-2.5-pro-preview-06-05'],
    patterns: [/\bgemini[-/.\s]?2\.?5\b.*\bpro\b/i],
    suites: {
      vista: 54.63,
      tutorbench: 55.65,
    },
  },
  {
    key: 'o3-pro',
    exactIds: ['openai/o3-pro'],
    patterns: [/(^|[\/\s_-])o3[-/.\s]?pro([\/\s_.-]|$)/i],
    suites: {
      professional_reasoning_legal: 49.67,
      tutorbench: 54.62,
    },
  },
  {
    key: 'o3',
    exactIds: ['openai/o3'],
    patterns: [/(^|[\/\s_-])o3([\/\s_.-]|$)/i],
    suites: {
      enigmaeval: 13.09,
    },
  },
  {
    key: 'glm-5',
    patterns: [/\bglm[-/.\s]?5\b/i],
    suites: {
      swe_atlas_qna: 21.77,
    },
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundToTenths(value) {
  return Math.round(value * 10) / 10;
}

function parseTimestampToMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return parseTimestampToMs(numeric);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeModelText(modelId, modelInfo = {}) {
  return [
    getCatalogModelLookupId(modelId),
    modelId,
    modelInfo?.id,
    modelInfo?.name,
    modelInfo?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function normalizeSuiteKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getSuiteMeta(suiteKey) {
  return BENCHMARK_SUITE_META[normalizeSuiteKey(suiteKey)] || null;
}

function normalizeBenchmarkScore({ value, min = 0, max = 100, higherIsBetter = true }) {
  const numericValue = Number(value);
  const numericMin = Number(min);
  const numericMax = Number(max);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericMin) || !Number.isFinite(numericMax) || numericMax <= numericMin) {
    return null;
  }
  const bounded = clamp((numericValue - numericMin) / (numericMax - numericMin), 0, 1);
  const normalized = higherIsBetter ? bounded : (1 - bounded);
  return normalized * 100;
}

function getBenchmarkFreshness(suiteKey, updatedAt, nowMs = Date.now()) {
  const meta = getSuiteMeta(suiteKey);
  const effectiveUpdatedAt = updatedAt || meta?.updatedAt || null;
  const updatedAtMs = parseTimestampToMs(effectiveUpdatedAt);
  if (!updatedAtMs) {
    return meta ? 0.76 : 0.62;
  }

  const ageDays = Math.max(0, (nowMs - updatedAtMs) / (24 * 60 * 60 * 1000));
  const maxAgeDays = Number(meta?.maxAgeDays);
  if (Number.isFinite(maxAgeDays) && ageDays >= maxAgeDays) {
    return 0;
  }

  const halfLifeDays = meta?.cadence === 'rolling' ? 45 : 180;
  return clamp(1 - (Math.log2(1 + (ageDays / halfLifeDays)) * 0.22), 0, 1);
}

function normalizeResolvedSuite(rawSuite, nowMs = Date.now()) {
  if (!rawSuite || typeof rawSuite !== 'object') return null;
  const suiteKey = normalizeSuiteKey(rawSuite.suite);
  if (!suiteKey) return null;
  const meta = getSuiteMeta(suiteKey) || {};
  const rawScore = rawSuite.rawScore ?? rawSuite.score ?? rawSuite.value;
  const normalizedScore = rawSuite.alreadyNormalized === true
    ? clamp(Number(rawScore), 0, 100)
    : normalizeBenchmarkScore({
      value: rawScore,
      min: rawSuite.min ?? meta.min ?? 0,
      max: rawSuite.max ?? meta.max ?? 100,
      higherIsBetter: rawSuite.higherIsBetter ?? meta.higherIsBetter ?? true,
    });
  if (!Number.isFinite(normalizedScore)) return null;

  const updatedAt = rawSuite.updatedAt || rawSuite.updated_at || meta.updatedAt || null;
  const freshness = getBenchmarkFreshness(suiteKey, updatedAt, nowMs);
  if (freshness <= 0) return null;

  return {
    suite: suiteKey,
    label: meta.label || rawSuite.label || suiteKey,
    category: rawSuite.category || meta.category || 'reasoning',
    score: normalizedScore,
    rawScore: Number(rawSuite.rawScore ?? rawSuite.score ?? rawSuite.value),
    sourceQuality: clamp(Number(rawSuite.sourceQuality ?? meta.sourceQuality ?? 0.88), 0.4, 1),
    updatedAt,
    freshness,
    source: rawSuite.source || 'unknown',
    sourceLabel: rawSuite.sourceLabel || meta.sourceLabel || null,
    sourceUrl: rawSuite.sourceUrl || meta.sourceUrl || null,
  };
}

function getCategoryWeights({ taskRequirements = null, preferredMode = 'balanced' } = {}) {
  const weights = {
    reasoning: 0.28,
    instruction: 0.18,
    chat: 0.14,
    coding: 0.14,
    math: 0.08,
    multimodal: 0.06,
    long_context: 0.12,
  };

  if (preferredMode === 'quality' || preferredMode === 'frontier') {
    weights.reasoning += 0.05;
    weights.coding += 0.03;
    weights.chat += 0.02;
  }
  if (preferredMode === 'fast') {
    weights.chat += 0.02;
    weights.instruction += 0.02;
  }

  const prefersImages = Boolean(taskRequirements?.requireImageInput || taskRequirements?.preferImageInput);
  if (prefersImages) {
    weights.multimodal += 0.22;
    weights.reasoning -= 0.05;
    weights.chat -= 0.04;
    weights.coding -= 0.03;
  }

  const contextTarget = Math.max(
    Number(taskRequirements?.minContextTokens || 0),
    Number(taskRequirements?.preferContextTokens || 0),
  );
  if (contextTarget >= 128_000) {
    weights.long_context += contextTarget >= 500_000 ? 0.2 : 0.12;
    weights.reasoning -= 0.04;
    weights.chat -= 0.03;
  }

  if (taskRequirements?.requireNativeWebSearch || taskRequirements?.preferNativeWebSearch) {
    weights.reasoning += 0.03;
    weights.instruction += 0.04;
  }

  const entries = Object.entries(weights).map(([key, value]) => [key, Math.max(0.02, value)]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}

function buildCuratedBenchmarks(entry, matchType, nowMs = Date.now()) {
  return Object.entries(entry?.suites || {})
    .map(([suiteKey, rawScore]) => normalizeResolvedSuite({
      suite: suiteKey,
      rawScore,
      source: `curated_${matchType}`,
    }, nowMs))
    .filter(Boolean);
}

function extractBenchmarksFromModelInfo(modelInfo = {}, nowMs = Date.now()) {
  const candidates = [
    modelInfo?.benchmarks,
    modelInfo?.benchmark_scores,
    modelInfo?.benchmarkScores,
    modelInfo?.evals,
    modelInfo?.evaluations,
    modelInfo?.capabilities?.benchmarks,
  ];

  const suites = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (!entry || typeof entry !== 'object') continue;
        const suite = normalizeResolvedSuite({
          suite: entry.suite || entry.name || entry.id || entry.metric,
          rawScore: entry.normalizedScore ?? entry.score ?? entry.value,
          alreadyNormalized: entry.normalizedScore != null,
          min: entry.min,
          max: entry.max,
          higherIsBetter: entry.higherIsBetter,
          category: entry.category,
          sourceQuality: entry.sourceQuality,
          updatedAt: entry.updatedAt || entry.updated_at || entry.date || null,
          source: 'model_catalog',
          sourceLabel: entry.sourceLabel || entry.provider || null,
          sourceUrl: entry.sourceUrl || entry.url || null,
        }, nowMs);
        if (suite) suites.push(suite);
      }
      continue;
    }

    if (typeof candidate === 'object') {
      for (const [key, rawValue] of Object.entries(candidate)) {
        if (rawValue == null) continue;
        const suite = typeof rawValue === 'object'
          ? normalizeResolvedSuite({
            suite: key,
            rawScore: rawValue.normalizedScore ?? rawValue.score ?? rawValue.value,
            alreadyNormalized: rawValue.normalizedScore != null,
            min: rawValue.min,
            max: rawValue.max,
            higherIsBetter: rawValue.higherIsBetter,
            category: rawValue.category,
            sourceQuality: rawValue.sourceQuality,
            updatedAt: rawValue.updatedAt || rawValue.updated_at || rawValue.date || null,
            source: 'model_catalog',
            sourceLabel: rawValue.sourceLabel || rawValue.provider || null,
            sourceUrl: rawValue.sourceUrl || rawValue.url || null,
          }, nowMs)
          : normalizeResolvedSuite({
            suite: key,
            rawScore: rawValue,
            source: 'model_catalog',
          }, nowMs);
        if (suite) suites.push(suite);
      }
    }
  }

  return suites;
}

function resolveCuratedBenchmarkEntry(modelId, modelInfo = {}) {
  const normalizedId = getCatalogModelLookupId(modelId) || String(modelId || '').trim();
  const text = normalizeModelText(modelId, modelInfo);

  for (const entry of CURATED_BENCHMARK_PRIORS) {
    if (Array.isArray(entry.exactIds) && entry.exactIds.includes(normalizedId)) {
      return { entry, matchType: 'exact' };
    }
  }

  for (const entry of CURATED_BENCHMARK_PRIORS) {
    const matched = Array.isArray(entry.patterns) && entry.patterns.some((pattern) => pattern.test(text));
    if (matched) {
      return { entry, matchType: 'pattern' };
    }
  }

  return null;
}

function aggregateCategoryScores(benchmarks = []) {
  const categories = new Map();
  for (const suite of benchmarks) {
    const category = String(suite?.category || 'reasoning');
    const current = categories.get(category) || { weightedScore: 0, totalWeight: 0, suites: [] };
    const weight = clamp(
      Number(suite?.sourceQuality ?? 0.8) * Number(suite?.freshness ?? 1),
      0.05,
      1.2,
    );
    current.weightedScore += Number(suite?.score || 0) * weight;
    current.totalWeight += weight;
    current.suites.push({
      suite: suite.suite,
      label: suite.label,
      score: roundToTenths(Number(suite.score || 0)),
      rawScore: Number.isFinite(suite.rawScore) ? roundToTenths(Number(suite.rawScore)) : null,
      source: suite.source || 'unknown',
      freshness: roundToTenths(Number(suite.freshness || 0) * 100) / 100,
    });
    categories.set(category, current);
  }

  return Object.fromEntries(
    Array.from(categories.entries()).map(([category, value]) => ([
      category,
      {
        score: value.totalWeight > 0 ? value.weightedScore / value.totalWeight : null,
        suiteCount: value.suites.length,
        suites: value.suites,
      },
    ]))
  );
}

function summarizeTopCategories(categoryScores = {}, categoryWeights = {}) {
  return Object.entries(categoryScores)
    .filter(([, value]) => Number.isFinite(value?.score))
    .map(([category, value]) => ({
      category,
      score: roundToTenths(value.score),
      weight: Number(categoryWeights?.[category] || 0),
    }))
    .sort((left, right) => (
      (right.weight * right.score) - (left.weight * left.score)
      || right.score - left.score
    ))
    .slice(0, 2);
}

export function resolveModelBenchmarkProfile({
  modelId,
  modelInfo = {},
  taskRequirements = null,
  preferredMode = 'balanced',
  nowMs = Date.now(),
} = {}) {
  const catalogBenchmarks = extractBenchmarksFromModelInfo(modelInfo, nowMs);
  const curated = resolveCuratedBenchmarkEntry(modelId, modelInfo);
  const curatedBenchmarks = curated ? buildCuratedBenchmarks(curated.entry, curated.matchType, nowMs) : [];
  const benchmarks = catalogBenchmarks.length > 0 ? catalogBenchmarks : curatedBenchmarks;

  if (benchmarks.length === 0) {
    return {
      score: null,
      confidence: 0,
      label: null,
      summary: null,
      source: null,
      matchType: 'none',
      freshness: 0,
      coverage: 0,
      sourceQuality: 0,
      categories: {},
      suites: [],
    };
  }

  const categoryWeights = getCategoryWeights({ taskRequirements, preferredMode });
  const categoryScores = aggregateCategoryScores(benchmarks);
  let totalWeight = 0;
  let weightedScore = 0;

  for (const [category, configWeight] of Object.entries(categoryWeights)) {
    const categoryScore = Number(categoryScores?.[category]?.score);
    if (!Number.isFinite(categoryScore)) continue;
    totalWeight += configWeight;
    weightedScore += categoryScore * configWeight;
  }

  const sourceQuality = benchmarks.reduce((sum, suite) => sum + Number(suite.sourceQuality || 0), 0) / Math.max(1, benchmarks.length);
  const freshness = benchmarks.reduce((sum, suite) => sum + Number(suite.freshness || 0), 0) / Math.max(1, benchmarks.length);
  const matchConfidence = curated?.matchType === 'exact'
    ? 1
    : curated?.matchType === 'pattern'
      ? 0.86
      : 0.95;
  const coverage = clamp(totalWeight, 0, 1);
  const confidence = clamp(
    (coverage * 0.5) +
    (sourceQuality * 0.22) +
    (freshness * 0.14) +
    (matchConfidence * 0.14),
    0,
    1,
  );
  const score = totalWeight > 0 ? weightedScore / totalWeight : null;
  const topCategories = summarizeTopCategories(categoryScores, categoryWeights);
  const categorySummary = topCategories
    .map((entry) => `${entry.category.replace('_', ' ')} ${entry.score}`)
    .join(' / ');

  return {
    score: Number.isFinite(score) ? roundToTenths(score) : null,
    confidence: roundToTenths(confidence * 100) / 100,
    label: categorySummary ? `benchmark ${categorySummary}` : 'benchmark-backed quality',
    summary: categorySummary ? `Current benchmark prior: ${categorySummary}` : 'Current benchmark prior available.',
    source: catalogBenchmarks.length > 0 ? 'model_catalog' : 'curated_public_snapshot',
    matchType: catalogBenchmarks.length > 0 ? 'catalog' : (curated?.matchType || 'none'),
    freshness: roundToTenths(freshness * 100) / 100,
    coverage: roundToTenths(coverage * 100) / 100,
    sourceQuality: roundToTenths(sourceQuality * 100) / 100,
    categories: Object.fromEntries(
      Object.entries(categoryScores).map(([category, value]) => [
        category,
        {
          score: Number.isFinite(value?.score) ? roundToTenths(value.score) : null,
          suiteCount: value?.suiteCount || 0,
        },
      ])
    ),
    suites: benchmarks
      .map((suite) => ({
        suite: suite.suite,
        label: suite.label,
        category: suite.category,
        score: roundToTenths(suite.score),
        rawScore: Number.isFinite(suite.rawScore) ? roundToTenths(suite.rawScore) : null,
        source: suite.source || 'unknown',
        sourceLabel: suite.sourceLabel || null,
        sourceUrl: suite.sourceUrl || null,
        freshness: roundToTenths(Number(suite.freshness || 0) * 100) / 100,
      }))
      .sort((left, right) => right.score - left.score),
  };
}
