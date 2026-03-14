// Rough token estimate: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;
const SUMMARY_THRESHOLD_TOKENS = 60000;

/**
 * Estimate token count from text length.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate total tokens for an array of messages.
 */
function estimateMessagesTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}

function truncateText(text, maxLength) {
  const safeText = typeof text === 'string' ? text : '';
  if (safeText.length <= maxLength) return safeText;
  return `${safeText.slice(0, maxLength)}...`;
}

function buildTurnMessages(turns) {
  const messages = [];

  for (const turn of turns) {
    messages.push({ role: 'user', content: turn.userPrompt });

    const richSummary = typeof turn.contextSummary === 'string'
      ? turn.contextSummary.trim()
      : '';
    if (richSummary) {
      messages.push({ role: 'assistant', content: richSummary });
    }
  }

  return messages;
}

/**
 * Build conversation history messages with smart context management.
 *
 * Strategy:
 * - A running summary replaces older summarized turns
 * - Turns already scheduled for summarization stay in the prompt until that
 *   summary has completed
 * - If the remaining context still grows too large, summarize additional
 *   newer turns and keep only the newest turns in full
 *
 * Returns { messages, needsSummary, summaryStartTurnIndex, summaryEndTurnIndex }
 */
export function buildConversationContext({
  conversation,
  runningSummary,
  summarizedTurnCount = 0,
  pendingSummaryUntilTurnCount = summarizedTurnCount,
}) {
  if (!conversation || !Array.isArray(conversation.turns) || conversation.turns.length === 0) {
    return {
      messages: [],
      needsSummary: false,
      summaryStartTurnIndex: 0,
      summaryEndTurnIndex: 0,
    };
  }

  const turns = conversation.turns;
  const messages = [];
  const normalizedSummarizedCount = Number.isFinite(Number(summarizedTurnCount))
    ? Math.max(0, Math.min(turns.length, Math.floor(Number(summarizedTurnCount))))
    : 0;
  const normalizedPendingCount = Number.isFinite(Number(pendingSummaryUntilTurnCount))
    ? Math.max(normalizedSummarizedCount, Math.min(turns.length, Math.floor(Number(pendingSummaryUntilTurnCount))))
    : normalizedSummarizedCount;

  if (runningSummary) {
    messages.push({
      role: 'system',
      content: `Previous conversation summary:\n${runningSummary}`,
    });
  }

  const pendingTurns = turns.slice(normalizedSummarizedCount, normalizedPendingCount);
  const unscheduledTurns = turns.slice(normalizedPendingCount);
  const pendingMessages = buildTurnMessages(pendingTurns);
  const unscheduledMessages = buildTurnMessages(unscheduledTurns);

  const totalTokens = estimateMessagesTokens(messages)
    + estimateMessagesTokens(pendingMessages)
    + estimateMessagesTokens(unscheduledMessages);
  if (totalTokens <= SUMMARY_THRESHOLD_TOKENS) {
    return {
      messages: [...messages, ...pendingMessages, ...unscheduledMessages],
      needsSummary: false,
      summaryStartTurnIndex: normalizedSummarizedCount,
      summaryEndTurnIndex: normalizedSummarizedCount,
    };
  }

  let keptTokens = estimateMessagesTokens(messages) + estimateMessagesTokens(pendingMessages);
  let keepFrom = unscheduledMessages.length;

  for (let index = unscheduledMessages.length - 1; index >= 0; index -= 1) {
    const messageTokens = estimateTokens(unscheduledMessages[index].content) + 4;
    if (keptTokens + messageTokens > SUMMARY_THRESHOLD_TOKENS) break;
    keptTokens += messageTokens;
    keepFrom = index;
  }

  keepFrom = Math.min(keepFrom, Math.max(0, unscheduledMessages.length - 2));

  const additionalTurnsToSummarize = Math.ceil(keepFrom / 2);
  const keptMessages = unscheduledMessages.slice(keepFrom);
  const summaryStartTurnIndex = normalizedPendingCount;
  const summaryEndTurnIndex = Math.max(
    summaryStartTurnIndex,
    Math.min(turns.length, normalizedPendingCount + additionalTurnsToSummarize),
  );

  return {
    messages: [...messages, ...pendingMessages, ...keptMessages],
    needsSummary: summaryEndTurnIndex > summaryStartTurnIndex,
    summaryStartTurnIndex,
    summaryEndTurnIndex,
  };
}

/**
 * Build a prompt to summarize older turns into a running summary.
 */
export function buildSummaryPrompt({ existingSummary, turnsToSummarize, startTurnNumber = 1 }) {
  const turnTexts = turnsToSummarize.map((turn, index) => {
    const parts = [`Turn ${startTurnNumber + index}:`];
    parts.push(`User: ${truncateText(turn.userPrompt, 200)}`);
    if (turn.synthesis?.content) {
      parts.push(`Answer: ${truncateText(turn.synthesis.content, 800)}`);
    }
    if (turn.debateMetadata?.totalRounds > 1) {
      parts.push(`(${turn.debateMetadata.totalRounds} debate rounds, ${turn.debateMetadata.converged ? 'converged' : 'did not converge'})`);
    }
    return parts.join('\n');
  }).join('\n\n---\n\n');

  const messages = [
    {
      role: 'system',
      content: 'You are a conversation summarizer. Create a concise but comprehensive summary that preserves key facts, decisions, constraints, and unresolved issues for future turns.',
    },
  ];

  if (existingSummary) {
    messages.push({
      role: 'user',
      content: `Here is the existing conversation summary through Turn ${Math.max(0, startTurnNumber - 1)}:\n${existingSummary}\n\nHere are new conversation turns to incorporate starting at Turn ${startTurnNumber}:\n${turnTexts}\n\nCreate an updated summary that incorporates all of this information.`,
    });
  } else {
    messages.push({
      role: 'user',
      content: `Summarize the following conversation turns starting at Turn ${startTurnNumber}, preserving all key information:\n\n${turnTexts}`,
    });
  }

  return messages;
}
