import assert from 'node:assert/strict';
import {
  deriveRoundStatusFromStreams,
  formatRetryProgressLabel,
  getRoundRepairStreamIndices,
  getReplacementModelChoices,
  getRetryScopeDescription,
  getStreamDisplayState,
  selectReplacementModel,
  streamNeedsRepair,
} from './retryState.js';

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

runTest('getStreamDisplayState treats carried-forward content as a warning state', () => {
  assert.deepEqual(
    getStreamDisplayState({
      status: 'complete',
      content: 'Existing answer',
      outcome: 'using_previous_response',
      error: 'Retry failed - showing previous response.',
    }),
    {
      kind: 'using_previous_response',
      tone: 'warning',
      label: 'Using prior answer',
    },
  );
});

runTest('deriveRoundStatusFromStreams marks mixed fresh and stale responses as warning', () => {
  assert.equal(
    deriveRoundStatusFromStreams([
      { status: 'complete', content: 'Fresh answer', outcome: 'success' },
      { status: 'complete', content: 'Older answer', outcome: 'using_previous_response' },
    ]),
    'warning',
  );
});

runTest('streamNeedsRepair treats interrupted and errored carried-forward responses as repairable', () => {
  assert.equal(
    streamNeedsRepair({
      status: 'complete',
      content: 'Partial answer',
      error: 'Run interrupted before completion.',
      outcome: 'using_previous_response',
    }, { retryErroredCompleted: true }),
    true,
  );
  assert.equal(
    streamNeedsRepair({
      status: 'error',
      content: '',
      error: 'Cancelled',
      errorKind: 'cancelled',
    }),
    true,
  );
});

runTest('getRoundRepairStreamIndices includes the requested stream and any repairable peers', () => {
  assert.deepEqual(
    getRoundRepairStreamIndices({
      streams: [
        { status: 'complete', content: 'Stable answer', outcome: 'success' },
        { status: 'complete', content: 'Interrupted answer', error: 'Run interrupted before completion.', outcome: 'using_previous_response' },
        { status: 'error', content: '', error: 'Cancelled', errorKind: 'cancelled' },
      ],
      retryErroredCompleted: true,
      preferredStreamIndices: [0],
    }),
    [0, 1, 2],
  );
});

runTest('getRoundRepairStreamIndices redoes every stream when explicitly redoing the round', () => {
  assert.deepEqual(
    getRoundRepairStreamIndices({
      streams: [
        { status: 'complete', content: 'A' },
        { status: 'complete', content: 'B' },
        { status: 'error', content: '', error: 'Failed' },
      ],
      redoRound: true,
    }),
    [0, 1, 2],
  );
});

runTest('formatRetryProgressLabel includes delay and attempt counters', () => {
  assert.equal(
    formatRetryProgressLabel({ active: true, attempt: 2, maxAttempts: 4, delayMs: 1500 }),
    'Retrying in 1.5s - attempt 2/4',
  );
});

runTest('getRetryScopeDescription explains debate round rebuild scope', () => {
  assert.equal(
    getRetryScopeDescription({
      scope: 'stream',
      mode: 'debate',
      roundNumber: 2,
      totalRounds: 4,
      modelName: 'Claude 4',
    }),
    'Retry Claude 4 in Round 2. This rebuilds Round 2 through Round 4 and refreshes the synthesized answer.',
  );
});

runTest('getReplacementModelChoices prefers fresh cross-provider options before same-round duplicates', () => {
  const choices = getReplacementModelChoices({
    currentModel: 'anthropic/claude-4-sonnet',
    roundModels: ['anthropic/claude-4-sonnet', 'openai/gpt-5'],
    modelCatalog: {
      'anthropic/claude-4-sonnet': {
        id: 'anthropic/claude-4-sonnet',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
      },
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        context_length: 200000,
        pricing: { prompt: 0.00001, completion: 0.00003 },
      },
      'google/gemini-2.5-pro': {
        id: 'google/gemini-2.5-pro',
        context_length: 200000,
        pricing: { prompt: 0.00000125, completion: 0.000005 },
      },
      'anthropic/claude-4-haiku': {
        id: 'anthropic/claude-4-haiku',
        context_length: 200000,
        pricing: { prompt: 0.0000008, completion: 0.000004 },
      },
    },
    metrics: {
      callCount: 12,
      failureByProvider: { anthropic: 4 },
    },
    rankingMode: 'balanced',
    rankingPreferences: {
      preferFlagship: true,
      preferNew: true,
      allowPreview: true,
    },
  });

  assert.equal(choices[0].modelId, 'google/gemini-2.5-pro');
  assert.equal(choices[0].recommended, true);
  assert.equal(choices[0].alreadyUsedInRound, false);
  assert.equal(choices[0].sameProvider, false);
  assert.equal(choices.at(-1).modelId, 'openai/gpt-5');
  assert.equal(choices.at(-1).alreadyUsedInRound, true);
});

runTest('selectReplacementModel prefers a different provider when available', () => {
  const replacement = selectReplacementModel({
    currentModel: 'anthropic/claude-4-sonnet',
    roundModels: ['anthropic/claude-4-sonnet', 'openai/gpt-5'],
    modelCatalog: {
      'anthropic/claude-4-sonnet': {
        id: 'anthropic/claude-4-sonnet',
        context_length: 200000,
        pricing: { prompt: 0.000003, completion: 0.000015 },
      },
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        context_length: 200000,
        pricing: { prompt: 0.00001, completion: 0.00003 },
      },
      'google/gemini-2.5-pro': {
        id: 'google/gemini-2.5-pro',
        context_length: 200000,
        pricing: { prompt: 0.00000125, completion: 0.000005 },
      },
      'anthropic/claude-4-haiku': {
        id: 'anthropic/claude-4-haiku',
        context_length: 200000,
        pricing: { prompt: 0.0000008, completion: 0.000004 },
      },
    },
    metrics: {
      callCount: 12,
      failureByProvider: { anthropic: 4 },
    },
    rankingMode: 'balanced',
    rankingPreferences: {
      preferFlagship: true,
      preferNew: true,
      allowPreview: true,
    },
  });

  assert.equal(replacement, 'google/gemini-2.5-pro');
});

// eslint-disable-next-line no-console
console.log('Retry state tests completed.');
