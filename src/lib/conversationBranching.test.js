import assert from 'node:assert/strict';
import {
  buildConversationSnapshotWithoutLastTurn,
  buildBranchTitle,
  createConversationHistoryBranch,
  describeConversationBranch,
  getBranchSourceSummary,
  shouldCreateConversationHistoryBranch,
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

runTest('shouldCreateConversationHistoryBranch respects recency and explicit branching', () => {
  assert.equal(
    shouldCreateConversationHistoryBranch({ isMostRecent: true, forceBranch: false }),
    false,
  );
  assert.equal(
    shouldCreateConversationHistoryBranch({ isMostRecent: false, forceBranch: false }),
    true,
  );
  assert.equal(
    shouldCreateConversationHistoryBranch({ isMostRecent: true, forceBranch: true }),
    true,
  );
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
    sourceStage: 'synthesis',
    sourceSummary: 'Retry Synthesis',
  });

  assert.equal(branch.id, 'branch-1');
  assert.equal(branch.title, 'Original chat (Retry)');
  assert.equal(branch.parentConversationId, 'conv-1');
  assert.deepEqual(branch.branchedFrom, {
    branchKind: 'retry',
    sourceTurnId: 'turn-1',
    sourceStage: 'synthesis',
    sourceRoundIndex: null,
    sourceSummary: 'Retry Synthesis',
  });
  assert.equal(branch.turns[0].rounds[0].streams[0].content, 'Original content');

  branch.turns[0].rounds[0].streams[0].content = 'Changed in branch';
  assert.equal(sourceConversation.turns[0].rounds[0].streams[0].content, 'Original content');
});

runTest('createConversationHistoryBranch supports checkpointed turn overrides with lineage', () => {
  const sourceConversation = {
    id: 'conv-1',
    title: 'Original chat',
    runningSummary: 'Turn 1 summary',
    summarizedTurnCount: 1,
    pendingSummaryUntilTurnCount: 1,
    turns: [{
      id: 'turn-1',
      userPrompt: 'Question',
      rounds: [{
        roundNumber: 1,
        streams: [{ model: 'openai/test', content: 'Original content', status: 'complete' }],
      }],
    }],
  };
  const overriddenTurns = [{
    id: 'turn-branch',
    userPrompt: 'Question',
    rounds: [{
      roundNumber: 1,
      streams: [{ model: 'openai/test', content: 'Checkpoint content', status: 'complete' }],
    }],
  }];

  const branch = createConversationHistoryBranch(sourceConversation, {
    branchConversationId: 'branch-checkpoint',
    createdAt: 222,
    titleLabel: 'After Round 1',
    branchKind: 'checkpoint',
    sourceStage: 'round',
    sourceRoundIndex: 0,
    sourceSummary: 'After Round 1',
    turnsOverride: overriddenTurns,
    sourceTurnId: 'turn-1',
  });

  assert.equal(branch.title, 'Original chat (After Round 1)');
  assert.deepEqual(branch.branchedFrom, {
    branchKind: 'checkpoint',
    sourceTurnId: 'turn-1',
    sourceStage: 'round',
    sourceRoundIndex: 0,
    sourceSummary: 'After Round 1',
  });
  assert.equal(branch.runningSummary, '');
  assert.equal(branch.summarizedTurnCount, 0);
  assert.equal(branch.pendingSummaryUntilTurnCount, 0);
  assert.equal(branch.turns[0].id, 'turn-branch');

  branch.turns[0].rounds[0].streams[0].content = 'Changed';
  assert.equal(overriddenTurns[0].rounds[0].streams[0].content, 'Checkpoint content');
});

runTest('createConversationHistoryBranch can branch from an earlier synthesized answer', () => {
  const sourceConversation = {
    id: 'conv-older-turn',
    title: 'Long chat',
    turns: [
      {
        id: 'turn-1',
        userPrompt: 'First question',
        synthesis: {
          model: 'openai/test',
          content: 'First synthesis',
          status: 'complete',
        },
      },
      {
        id: 'turn-2',
        userPrompt: 'Second question',
        synthesis: {
          model: 'openai/test',
          content: 'Second synthesis',
          status: 'complete',
        },
      },
    ],
  };

  const branch = createConversationHistoryBranch(sourceConversation, {
    branchConversationId: 'branch-from-first',
    createdAt: 333,
    titleLabel: 'After Synthesis',
    branchKind: 'checkpoint',
    sourceStage: 'synthesis',
    sourceSummary: 'After Synthesized Answer',
    turnsOverride: sourceConversation.turns.slice(0, 1),
    sourceTurnId: 'turn-1',
  });

  assert.equal(branch.title, 'Long chat (After Synthesis)');
  assert.equal(branch.turns.length, 1);
  assert.equal(branch.turns[0].id, 'turn-1');
  assert.deepEqual(branch.branchedFrom, {
    branchKind: 'checkpoint',
    sourceTurnId: 'turn-1',
    sourceStage: 'synthesis',
    sourceRoundIndex: null,
    sourceSummary: 'After Synthesized Answer',
  });
});

runTest('createConversationHistoryBranch infers sourceTurnId from the override when not supplied', () => {
  const sourceConversation = {
    id: 'conv-infer-turn',
    title: 'Long chat',
    turns: [
      { id: 'turn-1', synthesis: { status: 'complete', content: 'One' } },
      { id: 'turn-2', synthesis: { status: 'complete', content: 'Two' } },
    ],
  };

  const branch = createConversationHistoryBranch(sourceConversation, {
    branchConversationId: 'branch-infer-turn',
    createdAt: 444,
    titleLabel: 'After Synthesis',
    branchKind: 'checkpoint',
    sourceStage: 'synthesis',
    turnsOverride: sourceConversation.turns.slice(0, 1),
  });

  assert.equal(branch.branchedFrom.sourceTurnId, 'turn-1');
});

runTest('buildConversationSnapshotWithoutLastTurn clears stale summaries that included the removed turn', () => {
  const snapshot = buildConversationSnapshotWithoutLastTurn({
    id: 'conv-1',
    runningSummary: 'Summary through turn 2',
    summarizedTurnCount: 2,
    pendingSummaryUntilTurnCount: 2,
    turns: [
      { id: 'turn-1', userPrompt: 'First prompt' },
      { id: 'turn-2', userPrompt: 'Second prompt' },
    ],
  });

  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.runningSummary, '');
  assert.equal(snapshot.summarizedTurnCount, 0);
  assert.equal(snapshot.pendingSummaryUntilTurnCount, 0);
});

runTest('branch description helpers return readable lineage labels', () => {
  const branchedFrom = {
    branchKind: 'checkpoint',
    sourceTurnId: 'turn-1',
    sourceStage: 'synthesis',
    sourceRoundIndex: null,
    sourceSummary: 'After Synthesized Answer',
  };

  assert.equal(getBranchSourceSummary(branchedFrom), 'After Synthesized Answer');
  assert.deepEqual(describeConversationBranch(branchedFrom, 'Original chat'), {
    badgeLabel: 'After Synthesized Answer',
    parentLabel: 'Original chat',
    caption: 'from Original chat',
    tooltip: 'Checkpoint branch from Original chat • After Synthesized Answer',
  });
});

// eslint-disable-next-line no-console
console.log('Conversation branching tests completed.');
