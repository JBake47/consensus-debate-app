import assert from 'node:assert/strict';
import { buildConversationContext, buildSummaryPrompt } from './contextManager.js';

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

runTest('buildConversationContext excludes turns already covered by the running summary', () => {
  const conversation = {
    turns: [
      { userPrompt: 'old-1', contextSummary: 'summary-1' },
      { userPrompt: 'old-2', contextSummary: 'summary-2' },
      { userPrompt: 'recent', contextSummary: 'recent-summary' },
    ],
  };

  const result = buildConversationContext({
    conversation,
    runningSummary: 'Summarized first two turns',
    summarizedTurnCount: 2,
    pendingSummaryUntilTurnCount: 2,
  });

  assert.deepEqual(result.messages, [
    { role: 'system', content: 'Previous conversation summary:\nSummarized first two turns' },
    { role: 'user', content: 'recent' },
    { role: 'assistant', content: 'recent-summary' },
  ]);
  assert.equal(result.needsSummary, false);
});

runTest('buildConversationContext keeps pending turns in the prompt while only newer turns are planned for summary', () => {
  const longSummary = 'x'.repeat(70000);
  const conversation = {
    turns: [
      { userPrompt: 'old-a', contextSummary: 'old-summary' },
      { userPrompt: 'pending-a', contextSummary: longSummary },
      { userPrompt: 'pending-b', contextSummary: longSummary },
      { userPrompt: 'new-a', contextSummary: longSummary },
      { userPrompt: 'new-b', contextSummary: longSummary },
      { userPrompt: 'latest', contextSummary: longSummary },
    ],
  };

  const result = buildConversationContext({
    conversation,
    runningSummary: 'Existing running summary',
    summarizedTurnCount: 1,
    pendingSummaryUntilTurnCount: 3,
  });

  const promptMessages = result.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);

  assert.ok(promptMessages.includes('pending-a'));
  assert.ok(promptMessages.includes('pending-b'));
  assert.equal(result.summaryStartTurnIndex, 3);
  assert.ok(result.summaryEndTurnIndex > 3);
});

runTest('buildSummaryPrompt carries forward the start turn number when extending a summary', () => {
  const messages = buildSummaryPrompt({
    existingSummary: 'Earlier summary',
    turnsToSummarize: [{ userPrompt: 'What changed?', synthesis: { content: 'The latest answer' } }],
    startTurnNumber: 4,
  });

  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /through Turn 3/);
  assert.match(messages[1].content, /starting at Turn 4/);
});

// eslint-disable-next-line no-console
console.log('Context manager tests completed.');
