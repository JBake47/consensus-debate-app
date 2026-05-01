import assert from 'node:assert/strict';
import { prepareConversationsForPersistence } from './conversationPersistence.js';
import { shouldResumeDebateBeforeSynthesis } from './debateResume.js';
import {
  getLiveConversationRunScopes,
  getResumeRecoveryConversationIds,
  recoverInterruptedTurnState,
  resolveInitialActiveConversationId,
  resolvePreferredActiveConversationId,
  STALE_CONVERGENCE_REASON,
} from './conversationRecovery.js';

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

function createConversationFixture() {
  return [
    {
      id: 'conv-live',
      title: 'Live run',
      turns: [
        {
          id: 'turn-live',
          userPrompt: 'Keep working while I close the lid.',
          timestamp: 1_000,
          activeRunId: 'run-live',
          lastRunActivityAt: 5_000,
          webSearchResult: {
            status: 'searching',
            content: '',
          },
          rounds: [
            {
              roundNumber: 1,
              status: 'streaming',
              streams: [
                {
                  model: 'openai/test',
                  content: 'Partial answer',
                  status: 'streaming',
                  error: null,
                },
              ],
              convergenceCheck: {
                converged: null,
                reason: 'Checking...',
              },
            },
          ],
          synthesis: {
            model: 'openai/test',
            content: '',
            status: 'streaming',
            error: null,
          },
          debateMetadata: {
            totalRounds: 1,
            converged: false,
            terminationReason: null,
          },
        },
      ],
    },
    {
      id: 'conv-complete',
      title: 'Done run',
      turns: [
        {
          id: 'turn-complete',
          userPrompt: 'All done',
          timestamp: 2_000,
          activeRunId: null,
          rounds: [
            {
              roundNumber: 1,
              status: 'complete',
              streams: [
                {
                  model: 'openai/test',
                  content: 'Final answer',
                  status: 'complete',
                  error: null,
                },
              ],
            },
          ],
          synthesis: {
            model: 'openai/test',
            content: 'Final answer',
            status: 'complete',
            error: null,
          },
          debateMetadata: {
            totalRounds: 1,
            converged: false,
            terminationReason: 'max_rounds_reached',
          },
        },
      ],
    },
  ];
}

runTest('interrupted snapshot roundtrip restores the active conversation and recovers the live turn', () => {
  const prepared = prepareConversationsForPersistence(createConversationFixture(), 'balanced');
  const persisted = JSON.parse(JSON.stringify(prepared));
  const restored = persisted.map((conversation) => ({
    ...conversation,
    turns: conversation.turns.map((turn) => recoverInterruptedTurnState(turn).turn),
  }));
  const activeConversationId = resolveInitialActiveConversationId(restored, 'conv-live');
  const recoveredTurn = restored[0].turns[0];

  assert.equal(activeConversationId, 'conv-live');
  assert.equal(recoveredTurn.activeRunId, null);
  assert.equal(recoveredTurn.webSearchResult.status, 'error');
  assert.equal(recoveredTurn.rounds[0].streams[0].status, 'complete');
  assert.equal(recoveredTurn.rounds[0].streams[0].outcome, 'using_previous_response');
  assert.equal(recoveredTurn.rounds[0].convergenceCheck.converged, false);
  assert.equal(recoveredTurn.rounds[0].convergenceCheck.reason, STALE_CONVERGENCE_REASON);
  assert.equal(recoveredTurn.synthesis.status, 'error');
  assert.equal(recoveredTurn.debateMetadata.terminationReason, 'interrupted');
});

runTest('getLiveConversationRunScopes only returns currently running last turns', () => {
  const scopes = getLiveConversationRunScopes(createConversationFixture());

  assert.deepEqual(scopes, [
    {
      conversationId: 'conv-live',
      turnId: 'turn-live',
      runId: 'run-live',
    },
  ]);
});

runTest('getResumeRecoveryConversationIds only flags runs that were inactive long enough to be stale', () => {
  const fixture = createConversationFixture();
  const staleIds = getResumeRecoveryConversationIds(fixture, {
    hiddenAt: 10_000,
    resumedAt: 30_000,
    minHiddenMs: 15_000,
    maxRunInactivityMs: 15_000,
  });
  const freshIds = getResumeRecoveryConversationIds([
    {
      ...fixture[0],
      turns: [{
        ...fixture[0].turns[0],
        lastRunActivityAt: 28_500,
      }],
    },
  ], {
    hiddenAt: 10_000,
    resumedAt: 30_000,
    minHiddenMs: 15_000,
    maxRunInactivityMs: 15_000,
  });

  assert.deepEqual(staleIds, ['conv-live']);
  assert.deepEqual(freshIds, []);
});

runTest('pending final synthesis stays recoverable after model rounds finish', () => {
  const conversation = {
    id: 'conv-synthesis',
    title: 'Synthesis pending',
    turns: [
      {
        id: 'turn-synthesis',
        userPrompt: 'Finish the final synthesis.',
        timestamp: 4_000,
        activeRunId: 'run-synthesis',
        lastRunActivityAt: 8_000,
        rounds: [
          {
            roundNumber: 1,
            status: 'complete',
            streams: [
              {
                model: 'openai/test',
                content: 'Model output',
                status: 'complete',
                error: null,
              },
            ],
            convergenceCheck: {
              converged: false,
              reason: 'Need synthesis',
            },
          },
        ],
        synthesis: {
          model: 'openai/test',
          content: '',
          status: 'pending',
          error: null,
        },
        debateMetadata: {
          totalRounds: 1,
          converged: false,
          terminationReason: null,
        },
      },
    ],
  };

  assert.deepEqual(getLiveConversationRunScopes([conversation]), [
    {
      conversationId: 'conv-synthesis',
      turnId: 'turn-synthesis',
      runId: 'run-synthesis',
    },
  ]);

  const recoveredTurn = recoverInterruptedTurnState(conversation.turns[0]).turn;

  assert.equal(recoveredTurn.activeRunId, null);
  assert.equal(recoveredTurn.synthesis.status, 'error');
  assert.equal(recoveredTurn.synthesis.error, 'Run interrupted before completion.');
  assert.equal(recoveredTurn.debateMetadata.terminationReason, 'interrupted');
});

runTest('synthesis retry resumes a completed rebuttal round that still needs convergence', () => {
  const turn = {
    mode: 'debate',
    rounds: [
      {
        roundNumber: 1,
        status: 'complete',
        streams: [
          { model: 'openai/a', content: 'Initial A', status: 'complete' },
          { model: 'openai/b', content: 'Initial B', status: 'complete' },
        ],
      },
      {
        roundNumber: 2,
        status: 'complete',
        streams: [
          { model: 'openai/a', content: 'Rebuttal A', status: 'complete' },
          { model: 'openai/b', content: 'Rebuttal B', status: 'complete' },
        ],
        convergenceCheck: null,
      },
    ],
    synthesis: {
      model: 'openai/synth',
      content: '',
      status: 'error',
      error: 'Run interrupted before completion.',
    },
    debateMetadata: {
      totalRounds: 2,
      converged: false,
      terminationReason: 'interrupted',
    },
  };

  assert.equal(shouldResumeDebateBeforeSynthesis(turn, {
    maxRounds: 3,
    includeFinalRound: true,
  }), true);
});

runTest('synthesis retry resumes after a divergent interrupted rebuttal when rounds remain', () => {
  const turn = {
    mode: 'debate',
    rounds: [
      {
        roundNumber: 1,
        status: 'complete',
        streams: [
          { model: 'openai/a', content: 'Initial A', status: 'complete' },
          { model: 'openai/b', content: 'Initial B', status: 'complete' },
        ],
      },
      {
        roundNumber: 2,
        status: 'complete',
        streams: [
          { model: 'openai/a', content: 'Rebuttal A', status: 'complete' },
          { model: 'openai/b', content: 'Rebuttal B', status: 'complete' },
        ],
        convergenceCheck: {
          converged: false,
          reason: 'Still disagreeing.',
        },
      },
    ],
    debateMetadata: {
      totalRounds: 2,
      converged: false,
      terminationReason: 'interrupted',
    },
  };

  assert.equal(shouldResumeDebateBeforeSynthesis(turn, {
    maxRounds: 3,
    includeFinalRound: true,
  }), true);
});

runTest('synthesis retry does not resume debate when convergence already completed', () => {
  const turn = {
    mode: 'debate',
    rounds: [
      {
        roundNumber: 1,
        status: 'complete',
        streams: [
          { model: 'openai/a', content: 'Initial A', status: 'complete' },
          { model: 'openai/b', content: 'Initial B', status: 'complete' },
        ],
      },
      {
        roundNumber: 2,
        status: 'complete',
        streams: [
          { model: 'openai/a', content: 'Rebuttal A', status: 'complete' },
          { model: 'openai/b', content: 'Rebuttal B', status: 'complete' },
        ],
        convergenceCheck: {
          converged: true,
          reason: 'The models agree.',
        },
      },
    ],
    debateMetadata: {
      totalRounds: 2,
      converged: true,
      terminationReason: 'converged',
    },
  };

  assert.equal(shouldResumeDebateBeforeSynthesis(turn, {
    maxRounds: 3,
    includeFinalRound: true,
  }), false);
});

runTest('resolvePreferredActiveConversationId preserves explicit new-chat selection and falls back when needed', () => {
  const conversations = [
    { id: 'conv-a', turns: [] },
    { id: 'conv-b', turns: [] },
  ];

  assert.equal(resolvePreferredActiveConversationId(conversations, null, 'conv-a'), null);
  assert.equal(resolvePreferredActiveConversationId(conversations, 'conv-b', null), 'conv-b');
  assert.equal(resolvePreferredActiveConversationId(conversations, 'missing', 'conv-b'), 'conv-b');
  assert.equal(resolvePreferredActiveConversationId(conversations, 'missing', undefined), 'conv-a');
});

runTest('explicit new-chat selection does not clear live runs from other conversations', () => {
  const conversations = createConversationFixture();

  assert.equal(resolvePreferredActiveConversationId(conversations, null, 'conv-live'), null);
  assert.deepEqual(getLiveConversationRunScopes(conversations), [
    {
      conversationId: 'conv-live',
      turnId: 'turn-live',
      runId: 'run-live',
    },
  ]);
  assert.equal(conversations[0].turns[0].activeRunId, 'run-live');
});

// eslint-disable-next-line no-console
console.log('Conversation recovery tests completed.');
