import assert from 'node:assert/strict';
import { buildEnsembleQualityObservations } from './modelQualityTelemetry.js';
import {
  buildRankingTaskRequirements,
  rankModels,
  scoreModel,
  selectDiverseModels,
} from './modelRanking.js';

function runTest(name, fn) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

const BENCHMARK_NOW_MS = Date.parse('2026-03-18T00:00:00Z');

runTest('scoreModel prices output-heavy debate workloads correctly', () => {
  const workloadProfile = { inputTokens: 1000, outputTokens: 100000, callCount: 1 };
  const inputHeavyCheapOutput = scoreModel({
    modelId: 'openai/gpt-5-input-heavy',
    modelInfo: {
      id: 'openai/gpt-5-input-heavy',
      context_length: 200000,
      pricing: { prompt: 0.00002, completion: 0.000001 },
      created_at: '2026-01-01T00:00:00Z',
    },
    metrics: null,
    preferredMode: 'cheap',
    workloadProfile,
    nowMs: BENCHMARK_NOW_MS,
  });
  const outputHeavy = scoreModel({
    modelId: 'openai/gpt-5-output-heavy',
    modelInfo: {
      id: 'openai/gpt-5-output-heavy',
      context_length: 200000,
      pricing: { prompt: 0.000001, completion: 0.000008 },
      created_at: '2026-01-01T00:00:00Z',
    },
    metrics: null,
    preferredMode: 'cheap',
    workloadProfile,
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.ok(inputHeavyCheapOutput.expectedCostUsd < outputHeavy.expectedCostUsd);
  assert.ok(inputHeavyCheapOutput.signals.cost > outputHeavy.signals.cost);
});

runTest('rankModels uses per-model telemetry to favor faster and more reliable models', () => {
  const ranked = rankModels({
    modelCatalog: {
      'anthropic/claude-4-sonnet': {
        id: 'anthropic/claude-4-sonnet',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
    },
    metrics: {
      successCount: 20,
      failureCount: 4,
      retryAttempts: 5,
      failureByProvider: { openai: 4 },
      modelStats: {
        'anthropic/claude-4-sonnet': {
          requestCount: 12,
          successCount: 12,
          failureCount: 0,
          retryAttempts: 0,
          retryRecovered: 0,
          cacheHits: 1,
          firstTokenLatencies: [420, 440, 470, 500, 520],
          durations: [2300, 2400, 2500, 2600, 2700],
        },
        'openai/gpt-5': {
          requestCount: 12,
          successCount: 8,
          failureCount: 4,
          retryAttempts: 4,
          retryRecovered: 1,
          cacheHits: 0,
          firstTokenLatencies: [4200, 4600, 5100, 6200, 6800],
          durations: [14000, 15500, 17000, 18000, 21000],
        },
      },
    },
    preferredMode: 'balanced',
    limit: 2,
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.equal(ranked[0].modelId, 'anthropic/claude-4-sonnet');
  assert.ok(ranked[0].signals.reliability > ranked[1].signals.reliability);
  assert.ok(ranked[0].signals.speed > ranked[1].signals.speed);
});

runTest('rankModels uses benchmark priors when runtime telemetry is sparse', () => {
  const ranked = rankModels({
    modelCatalog: {
      'google/gemini-3-pro-preview': {
        id: 'google/gemini-3-pro-preview',
        context_length: 1_000_000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
      'glm/glm-5': {
        id: 'glm/glm-5',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
    },
    preferredMode: 'quality',
    limit: 2,
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.equal(ranked[0].modelId, 'google/gemini-3-pro-preview');
  assert.ok(ranked[0].qualityBreakdown.benchmark.score > ranked[1].qualityBreakdown.benchmark.score);
});

runTest('rankModels shifts benchmark weighting toward multimodal quality when image input matters', () => {
  const ranked = rankModels({
    modelCatalog: {
      'openai/gpt-5-thinking': {
        id: 'openai/gpt-5-thinking',
        modalities: ['text', 'image'],
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
      'google/gemini-3-pro-preview': {
        id: 'google/gemini-3-pro-preview',
        modalities: ['text', 'image'],
        context_length: 1_000_000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
    },
    preferredMode: 'quality',
    taskRequirements: {
      preferImageInput: true,
      requireImageInput: true,
    },
    limit: 2,
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.equal(ranked[0].modelId, 'google/gemini-3-pro-preview');
});

runTest('ensemble judge feedback can override benchmark priors when enough app evidence exists', () => {
  const ranked = rankModels({
    modelCatalog: {
      'anthropic/claude-opus-4.6': {
        id: 'anthropic/claude-opus-4.6',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-01-01T00:00:00Z',
      },
    },
    metrics: {
      successCount: 16,
      failureCount: 0,
      retryAttempts: 0,
      failureByProvider: {},
      modelStats: {
        'anthropic/claude-opus-4.6': {
          requestCount: 8,
          successCount: 8,
          failureCount: 0,
          firstTokenLatencies: [550, 580, 600],
          durations: [2500, 2600, 2700],
          qualityVoteCount: 8,
          judgeSignalWeightTotal: 6.4,
          judgeRelativeWeightTotal: 10.9,
          judgeTopPlacementWeight: 4.4,
          judgeOutlierWeight: 0.2,
        },
        'openai/gpt-5': {
          requestCount: 8,
          successCount: 8,
          failureCount: 0,
          firstTokenLatencies: [550, 580, 600],
          durations: [2500, 2600, 2700],
          qualityVoteCount: 8,
          judgeSignalWeightTotal: 6.4,
          judgeRelativeWeightTotal: 4.6,
          judgeTopPlacementWeight: 0.8,
          judgeOutlierWeight: 1.8,
        },
      },
    },
    preferredMode: 'quality',
    limit: 2,
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.equal(ranked[0].modelId, 'anthropic/claude-opus-4.6');
  assert.ok(ranked[0].qualityBreakdown.feedback.score > ranked[1].qualityBreakdown.feedback.score);
});

runTest('stale rolling suites are ignored in favor of current benchmark sources', () => {
  const scored = scoreModel({
    modelId: 'openai/gpt-5',
    modelInfo: {
      id: 'openai/gpt-5',
      context_length: 200000,
      pricing: { prompt: 0.000003, completion: 0.000015 },
      created_at: '2026-01-01T00:00:00Z',
      benchmarks: [
        { suite: 'aider_polyglot', score: 95, updatedAt: '2025-08-25T00:00:00Z' },
        { suite: 'humanitys_last_exam', score: 31.64, updatedAt: '2026-03-18T00:00:00Z' },
      ],
    },
    preferredMode: 'quality',
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.ok(scored.qualityBreakdown.benchmark.suites.some((suite) => suite.suite === 'humanitys_last_exam'));
  assert.ok(!scored.qualityBreakdown.benchmark.suites.some((suite) => suite.suite === 'aider_polyglot'));
});

runTest('catalog normalized benchmark scores are not re-normalized against suite ranges', () => {
  const scored = scoreModel({
    modelId: 'openai/gpt-5',
    modelInfo: {
      id: 'openai/gpt-5',
      context_length: 200000,
      pricing: { prompt: 0.000003, completion: 0.000015 },
      created_at: '2026-01-01T00:00:00Z',
      benchmarks: [
        { suite: 'humanitys_last_exam', normalizedScore: 80 },
      ],
    },
    preferredMode: 'quality',
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.equal(scored.qualityBreakdown.benchmark.score, 80);
  assert.equal(scored.qualityBreakdown.benchmark.suites[0].score, 80);
});

runTest('current 2026 coding priors recognize newer codex-family leaders', () => {
  const ranked = rankModels({
    modelCatalog: {
      'openai/gpt-5.4-codex': {
        id: 'openai/gpt-5.4-codex',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2026-03-09T00:00:00Z',
      },
      'openai/gpt-5.2': {
        id: 'openai/gpt-5.2',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
        created_at: '2025-12-11T00:00:00Z',
      },
    },
    preferredMode: 'quality',
    limit: 2,
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.equal(ranked[0].modelId, 'openai/gpt-5.4-codex');
  assert.ok(ranked[0].qualityBreakdown.benchmark.score > ranked[1].qualityBreakdown.benchmark.score);
});

runTest('buildRankingTaskRequirements carries current-model capability floors and task hints', () => {
  const requirements = buildRankingTaskRequirements({
    currentModel: 'openai/gpt-5',
    modelCatalog: {
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        context_length: 200000,
        max_output_tokens: 32000,
      },
    },
    attachments: [{ category: 'image', name: 'diagram.png' }],
    webSearchEnabled: true,
  });

  assert.equal(requirements.preferImageInput, true);
  assert.equal(requirements.preferNativeWebSearch, true);
  assert.equal(requirements.preferContextTokens, 200000);
  assert.equal(requirements.preferOutputTokens, 32000);
});

runTest('rankModels filters models that miss required image input', () => {
  const ranked = rankModels({
    modelCatalog: {
      'openai/gpt-5-vision': {
        id: 'openai/gpt-5-vision',
        modalities: ['text', 'image'],
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000012 },
      },
      'openai/gpt-5-text': {
        id: 'openai/gpt-5-text',
        modalities: ['text'],
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000012 },
      },
    },
    taskRequirements: {
      requireImageInput: true,
    },
    limit: 4,
    nowMs: BENCHMARK_NOW_MS,
  });

  assert.deepEqual(ranked.map((entry) => entry.modelId), ['openai/gpt-5-vision']);
});

runTest('selectDiverseModels spreads the top picks across providers and families', () => {
  const selected = selectDiverseModels({
    rankedModels: [
      { modelId: 'openai/gpt-5', score: 99, provider: 'openai', family: 'gpt-5', telemetry: { requestCount: 10 } },
      { modelId: 'openai/gpt-5-mini', score: 97, provider: 'openai', family: 'gpt-5', telemetry: { requestCount: 10 } },
      { modelId: 'openai/gpt-4.1', score: 96, provider: 'openai', family: 'gpt-4', telemetry: { requestCount: 10 } },
      { modelId: 'anthropic/claude-4-sonnet', score: 95, provider: 'anthropic', family: 'claude-4', telemetry: { requestCount: 10 } },
      { modelId: 'google/gemini-2.5-pro', score: 94, provider: 'gemini', family: 'gemini-2.5', telemetry: { requestCount: 10 } },
    ],
    count: 3,
  });

  assert.deepEqual(
    selected.map((entry) => entry.modelId),
    ['openai/gpt-5', 'anthropic/claude-4-sonnet', 'google/gemini-2.5-pro'],
  );
});

runTest('buildEnsembleQualityObservations normalizes judge weights and tracks outliers', () => {
  const observations = buildEnsembleQualityObservations({
    completedStreams: [
      { model: 'openai/gpt-5' },
      { model: 'anthropic/claude-4-sonnet' },
      { model: 'google/gemini-2.5-pro' },
    ],
    voteAnalysis: {
      confidence: 80,
      modelWeights: {
        'openai/gpt-5': 0.6,
        'anthropic/claude-4-sonnet': 0.3,
      },
      outliers: [{ model: 'google/gemini-2.5-pro', reason: 'Missed key evidence' }],
    },
  });

  assert.equal(Object.keys(observations).length, 3);
  assert.ok(observations['openai/gpt-5'].judgeRelativeWeightDelta > observations['anthropic/claude-4-sonnet'].judgeRelativeWeightDelta);
  assert.ok(observations['anthropic/claude-4-sonnet'].judgeRelativeWeightDelta > observations['google/gemini-2.5-pro'].judgeRelativeWeightDelta);
  assert.ok(observations['google/gemini-2.5-pro'].judgeOutlierDelta > 0);
});

// eslint-disable-next-line no-console
console.log('Model ranking tests completed.');
