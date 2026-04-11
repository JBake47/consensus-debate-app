import assert from 'node:assert/strict';
import { buildConversationListItem, markConversationSummaryProgress } from './conversationIndex.js';

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

runTest('buildConversationListItem exposes the current turn start timestamp', () => {
  const result = buildConversationListItem({
    id: 'conv-1',
    title: 'Task 1',
    createdAt: 10,
    updatedAt: 30,
    parentConversationId: 'conv-0',
    branchedFrom: {
      branchKind: 'checkpoint',
      sourceTurnId: 'turn-0',
      sourceStage: 'synthesis',
      sourceRoundIndex: null,
      sourceSummary: 'After Synthesized Answer',
    },
    turns: [
      { id: 'turn-1', timestamp: 20 },
      { id: 'turn-2', timestamp: 25 },
    ],
  });

  assert.equal(result.lastTurnTimestamp, 25);
  assert.equal(result.turnCount, 2);
  assert.equal(result.parentConversationId, 'conv-0');
  assert.equal(result.branchedFrom.branchKind, 'checkpoint');
});

// eslint-disable-next-line no-console
console.log('Conversation index tests completed.');
