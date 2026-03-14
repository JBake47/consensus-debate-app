import assert from 'node:assert/strict';
import { markConversationSummaryProgress } from './conversationIndex.js';

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

runTest('markConversationSummaryProgress applies an in-order summary result', () => {
  const conversation = {
    runningSummary: 'Old summary',
    summarizedTurnCount: 1,
    pendingSummaryUntilTurnCount: 3,
    turns: [{}, {}, {}, {}],
  };

  const result = markConversationSummaryProgress(conversation, 'New summary', 3, 3);

  assert.equal(result.runningSummary, 'New summary');
  assert.equal(result.summarizedTurnCount, 3);
  assert.equal(result.pendingSummaryUntilTurnCount, 3);
});

runTest('markConversationSummaryProgress ignores stale summary results once pending work has moved', () => {
  const conversation = {
    runningSummary: 'Old summary',
    summarizedTurnCount: 1,
    pendingSummaryUntilTurnCount: 4,
    turns: [{}, {}, {}, {}],
  };

  const result = markConversationSummaryProgress(conversation, 'Stale summary', 3, 3);

  assert.equal(result, conversation);
});

// eslint-disable-next-line no-console
console.log('Conversation index tests completed.');
