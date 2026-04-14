import assert from 'node:assert/strict';
import {
  addConversationDeletionTombstone,
  buildConversationStoreSnapshotSignature,
  mergeConversationStoreSnapshots,
  removeConversationDeletionTombstones,
} from './conversationStoreSnapshot.js';

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

function createConversation(id, overrides = {}) {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: 1_000,
    updatedAt: 1_000,
    turns: [],
    ...overrides,
  };
}

runTest('mergeConversationStoreSnapshots preserves chats created in different tabs', () => {
  const baseSnapshot = {
    savedAt: 2_000,
    activeConversationId: 'conv-a',
    conversations: [
      createConversation('conv-a', { updatedAt: 2_000 }),
    ],
  };
  const incomingSnapshot = {
    savedAt: 3_000,
    activeConversationId: 'conv-b',
    conversations: [
      createConversation('conv-b', { updatedAt: 3_000 }),
    ],
  };

  const merged = mergeConversationStoreSnapshots(baseSnapshot, incomingSnapshot);

  assert.deepEqual(
    merged.conversations.map((conversation) => conversation.id),
    ['conv-b', 'conv-a'],
  );
});

runTest('mergeConversationStoreSnapshots prefers the richer version when timestamps match', () => {
  const baseSnapshot = {
    conversations: [
      createConversation('conv-a', {
        updatedAt: 5_000,
        turns: [{ id: 'turn-1', timestamp: 5_000 }],
      }),
    ],
  };
  const incomingSnapshot = {
    conversations: [
      createConversation('conv-a', {
        updatedAt: 5_000,
        turns: [
          { id: 'turn-1', timestamp: 5_000 },
          { id: 'turn-2', timestamp: 5_100 },
        ],
      }),
    ],
  };

  const merged = mergeConversationStoreSnapshots(baseSnapshot, incomingSnapshot);

  assert.equal(merged.conversations[0].turns.length, 2);
});

runTest('mergeConversationStoreSnapshots respects deletion tombstones', () => {
  const merged = mergeConversationStoreSnapshots(
    {
      conversations: [
        createConversation('conv-a', { updatedAt: 4_000 }),
      ],
    },
    {
      deletedConversationTombstones: {
        'conv-a': 4_500,
      },
    },
  );

  assert.equal(merged.conversations.length, 0);
  assert.equal(merged.deletedConversationTombstones['conv-a'], 4_500);
});

runTest('mergeConversationStoreSnapshots keeps a newer recreation over an older tombstone', () => {
  const merged = mergeConversationStoreSnapshots(
    {
      deletedConversationTombstones: {
        'conv-a': 4_500,
      },
    },
    {
      conversations: [
        createConversation('conv-a', { updatedAt: 5_000 }),
      ],
    },
  );

  assert.deepEqual(
    merged.conversations.map((conversation) => conversation.id),
    ['conv-a'],
  );
});

runTest('mergeConversationStoreSnapshots preserves a newer explicit blank-chat selection', () => {
  const merged = mergeConversationStoreSnapshots(
    {
      savedAt: 4_000,
      activeConversationId: 'conv-a',
      conversations: [
        createConversation('conv-a', { updatedAt: 4_000 }),
        createConversation('conv-b', { updatedAt: 3_500 }),
      ],
    },
    {
      savedAt: 5_000,
      activeConversationId: null,
      conversations: [
        createConversation('conv-a', { updatedAt: 4_000 }),
        createConversation('conv-b', { updatedAt: 5_000 }),
      ],
    },
  );

  assert.equal(merged.activeConversationId, null);
  assert.deepEqual(
    merged.conversations.map((conversation) => conversation.id),
    ['conv-b', 'conv-a'],
  );
});

runTest('conversation deletion tombstones can be removed when a chat is reintroduced', () => {
  const tombstones = addConversationDeletionTombstone({}, 'conv-a', 8_000);
  const next = removeConversationDeletionTombstones(tombstones, ['conv-a']);

  assert.deepEqual(next, {});
});

runTest('buildConversationStoreSnapshotSignature is stable across ordering differences', () => {
  const left = {
    activeConversationId: 'conv-a',
    deletedConversationTombstones: { 'conv-z': 9_000 },
    conversations: [
      createConversation('conv-a', { updatedAt: 3_000 }),
      createConversation('conv-b', { updatedAt: 2_000 }),
    ],
  };
  const right = {
    activeConversationId: 'conv-a',
    deletedConversationTombstones: { 'conv-z': 9_000 },
    conversations: [
      createConversation('conv-b', { updatedAt: 2_000 }),
      createConversation('conv-a', { updatedAt: 3_000 }),
    ],
  };

  assert.equal(
    buildConversationStoreSnapshotSignature(left),
    buildConversationStoreSnapshotSignature(right),
  );
});

// eslint-disable-next-line no-console
console.log('Conversation store snapshot tests completed.');
