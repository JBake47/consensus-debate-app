import assert from 'node:assert/strict';
import {
  buildResetSynthesisState,
  getSynthesisStreamingLabel,
} from './synthesisState.js';

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

runTest('buildResetSynthesisState preserves completed synthesis content during retries', () => {
  const next = buildResetSynthesisState(
    {
      model: 'openai/gpt-5',
      content: 'Existing synthesis',
      status: 'complete',
      error: null,
      usage: { totalTokens: 42 },
      durationMs: 900,
      completedAt: 12345,
    },
    'openai/gpt-5',
    { preserveContent: true },
  );

  assert.deepEqual(next, {
    model: 'openai/gpt-5',
    content: 'Existing synthesis',
    status: 'streaming',
    error: null,
    retryProgress: null,
    usage: { totalTokens: 42 },
    durationMs: 900,
    completedAt: 12345,
  });
});

runTest('buildResetSynthesisState falls back to a blank pending state when nothing can be preserved', () => {
  const next = buildResetSynthesisState(
    {
      model: 'openai/gpt-5',
      content: '',
      status: 'error',
      error: 'Boom',
    },
    'anthropic/claude',
    { preserveContent: true },
  );

  assert.deepEqual(next, {
    model: 'anthropic/claude',
    content: '',
    status: 'pending',
    error: null,
    retryProgress: null,
  });
});

runTest('getSynthesisStreamingLabel distinguishes a refresh from an initial synthesis', () => {
  assert.equal(
    getSynthesisStreamingLabel({ status: 'streaming', content: 'Existing synthesis', completedAt: 1 }),
    'Refreshing...',
  );
  assert.equal(
    getSynthesisStreamingLabel({ status: 'streaming', content: 'Partial answer', completedAt: null }),
    'Synthesizing...',
  );
  assert.equal(
    getSynthesisStreamingLabel({ status: 'complete', content: 'Done', completedAt: 1 }),
    null,
  );
});

runTest('getSynthesisStreamingLabel surfaces automatic retry progress', () => {
  assert.equal(
    getSynthesisStreamingLabel({
      status: 'streaming',
      retryProgress: { active: true, attempt: 2, maxAttempts: 4, delayMs: 1500 },
    }),
    'Retrying in 1.5s - attempt 2/4',
  );
});

// eslint-disable-next-line no-console
console.log('Synthesis state tests completed.');
