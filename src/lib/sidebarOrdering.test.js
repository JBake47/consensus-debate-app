import assert from 'node:assert/strict';
import {
  getMostRecentConversation,
  isMostRecentConversation,
  getSidebarConversationSortTimestamp,
  sortSidebarConversations,
} from './sidebarOrdering.js';

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

runTest('running conversations sort by turn start time instead of live updatedAt churn', () => {
  const sorted = sortSidebarConversations(
    [
      { id: 'older-run', updatedAt: 400, createdAt: 10, lastTurnTimestamp: 100 },
      { id: 'newer-run', updatedAt: 300, createdAt: 20, lastTurnTimestamp: 200 },
    ],
    (conversationId) => conversationId === 'older-run' || conversationId === 'newer-run',
  );

  assert.deepEqual(sorted.map((conversation) => conversation.id), ['newer-run', 'older-run']);
});

runTest('completed conversations still sort by updatedAt', () => {
  const sorted = sortSidebarConversations([
    { id: 'older', updatedAt: 100, createdAt: 10, lastTurnTimestamp: 20 },
    { id: 'newer', updatedAt: 200, createdAt: 20, lastTurnTimestamp: 30 },
  ]);

  assert.deepEqual(sorted.map((conversation) => conversation.id), ['newer', 'older']);
});

runTest('running conversations fall back to updatedAt when the turn start time is unavailable', () => {
  const sortTimestamp = getSidebarConversationSortTimestamp(
    { id: 'conv-1', updatedAt: 120, createdAt: 80, lastTurnTimestamp: 0 },
    true,
  );

  assert.equal(sortTimestamp, 120);
});

runTest('getMostRecentConversation returns the same chat the sidebar would place first', () => {
  const latest = getMostRecentConversation([
    { id: 'older', updatedAt: 100, createdAt: 10, lastTurnTimestamp: 20 },
    { id: 'newer', updatedAt: 200, createdAt: 20, lastTurnTimestamp: 30 },
  ]);

  assert.equal(latest?.id, 'newer');
});

runTest('isMostRecentConversation detects whether a chat is still the newest one', () => {
  const conversations = [
    { id: 'older', updatedAt: 100, createdAt: 10, lastTurnTimestamp: 20 },
    { id: 'newer', updatedAt: 200, createdAt: 20, lastTurnTimestamp: 30 },
  ];

  assert.equal(isMostRecentConversation(conversations, 'newer'), true);
  assert.equal(isMostRecentConversation(conversations, 'older'), false);
});

// eslint-disable-next-line no-console
console.log('Sidebar ordering tests completed.');
