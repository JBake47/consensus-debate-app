import assert from 'node:assert/strict';
import {
  buildBranchTitle,
  createConversationHistoryBranch,
} from './conversationBranching.js';

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

runTest('buildBranchTitle appends a readable suffix', () => {
  assert.equal(buildBranchTitle('Alpha chat', 'Retry'), 'Alpha chat (Retry)');
  assert.equal(buildBranchTitle('', 'Edit'), 'Debate (Edit)');
});

runTest('createConversationHistoryBranch clones conversation data and annotates lineage', () => {
  const sourceConversation = {
    id: 'conv-1',
    title: 'Original chat',
    description: 'Seeded from a prior run',
    createdAt: 10,
    updatedAt: 20,
    turns: [{
      id: 'turn-1',
      userPrompt: 'Question',
      rounds: [{
        roundNumber: 1,
        streams: [{
          model: 'openai/test',
          content: 'Original content',
          status: 'complete',
        }],
      }],
      synthesis: {
        model: 'openai/test',
        content: 'Original synthesis',
        status: 'complete',
      },
    }],
  };

  const branch = createConversationHistoryBranch(sourceConversation, {
    branchConversationId: 'branch-1',
    createdAt: 123,
    titleLabel: 'Retry',
    branchKind: 'retry',
  });

  assert.equal(branch.id, 'branch-1');
  assert.equal(branch.title, 'Original chat (Retry)');
  assert.equal(branch.parentConversationId, 'conv-1');
  assert.deepEqual(branch.branchedFrom, {
    branchKind: 'retry',
    sourceTurnId: 'turn-1',
  });
  assert.equal(branch.turns[0].rounds[0].streams[0].content, 'Original content');

  branch.turns[0].rounds[0].streams[0].content = 'Changed in branch';
  assert.equal(sourceConversation.turns[0].rounds[0].streams[0].content, 'Original content');
});

// eslint-disable-next-line no-console
console.log('Conversation branching tests completed.');
