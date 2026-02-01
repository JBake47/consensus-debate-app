import { getModelDisplayName } from './openrouter';

// Rough token estimate: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_TOKENS = 100000;
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
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/**
 * Build a rich summary of a single turn for context.
 * Includes model highlights and synthesis, not just synthesis alone.
 */
function summarizeTurnForContext(turn) {
  const parts = [];

  // Include web search context if it existed
  if (turn.webSearchResult?.content && turn.webSearchResult.status === 'complete') {
    parts.push(`[Web search was performed for this query]`);
  }

  // Include key model positions from the final round
  if (turn.rounds && turn.rounds.length > 0) {
    const finalRound = turn.rounds[turn.rounds.length - 1];
    const modelSummaries = finalRound.streams
      .filter(s => s.content && s.status === 'complete')
      .map(s => `${getModelDisplayName(s.model)}: ${truncateText(s.content, 500)}`)
      .join('\n');
    if (modelSummaries) {
      parts.push(`Model positions (${finalRound.label}):\n${modelSummaries}`);
    }
  }

  // Include debate metadata
  if (turn.debateMetadata) {
    const { totalRounds, converged, terminationReason } = turn.debateMetadata;
    if (totalRounds > 1) {
      parts.push(`[Debate: ${totalRounds} rounds, ${converged ? 'converged' : terminationReason}]`);
    }
  }

  // Include synthesis (primary context)
  if (turn.synthesis?.content && turn.synthesis.status === 'complete') {
    parts.push(`Synthesized answer:\n${turn.synthesis.content}`);
  }

  return parts.join('\n\n');
}

/**
 * Truncate text to a maximum length, adding ellipsis.
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Build conversation history messages with smart context management.
 *
 * Strategy:
 * - Recent turns get full context (synthesis + model positions)
 * - If a running summary exists, it's prepended as a system-level recap
 * - If total context exceeds the threshold, older turns are compressed
 *
 * Returns { messages, needsSummary, turnsToSummarize }
 */
export function buildConversationContext({ conversation, runningSummary }) {
  if (!conversation || !conversation.turns || conversation.turns.length === 0) {
    return { messages: [], needsSummary: false, turnsToSummarize: 0 };
  }

  const turns = conversation.turns;
  const messages = [];

  // Add running summary if it exists
  if (runningSummary) {
    messages.push({
      role: 'system',
      content: `Previous conversation summary:\n${runningSummary}`,
    });
  }

  // Build messages from all turns with rich context
  const turnMessages = [];
  for (const turn of turns) {
    turnMessages.push({ role: 'user', content: turn.userPrompt });

    const richSummary = summarizeTurnForContext(turn);
    if (richSummary) {
      turnMessages.push({ role: 'assistant', content: richSummary });
    }
  }

  // Check if we need to compress
  const totalTokens = estimateMessagesTokens(messages) + estimateMessagesTokens(turnMessages);

  if (totalTokens <= SUMMARY_THRESHOLD_TOKENS) {
    // Everything fits — use full context
    return {
      messages: [...messages, ...turnMessages],
      needsSummary: false,
      turnsToSummarize: 0,
    };
  }

  // Context is too large — keep recent turns in full, mark older ones for summarization
  // Work backwards from the most recent turn to find how many we can keep in full
  let keptTokens = estimateMessagesTokens(messages);
  let keepFrom = turnMessages.length;

  for (let i = turnMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(turnMessages[i].content) + 4;
    if (keptTokens + msgTokens > SUMMARY_THRESHOLD_TOKENS) break;
    keptTokens += msgTokens;
    keepFrom = i;
  }

  // Ensure we keep at least the last 2 messages (user + assistant for last turn)
  keepFrom = Math.min(keepFrom, Math.max(0, turnMessages.length - 2));

  const turnsToSummarize = Math.ceil(keepFrom / 2); // Each turn = ~2 messages
  const keptMessages = turnMessages.slice(keepFrom);

  return {
    messages: [...messages, ...keptMessages],
    needsSummary: turnsToSummarize > 0,
    turnsToSummarize,
  };
}

/**
 * Build a prompt to summarize older turns into a running summary.
 */
export function buildSummaryPrompt({ existingSummary, turnsToSummarize }) {
  const turnTexts = turnsToSummarize.map((turn, i) => {
    const parts = [`Turn ${i + 1}:`];
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
      content: `You are a conversation summarizer. Create a concise but comprehensive summary that preserves all key facts, decisions, and context from the conversation. This summary will be used as context for future messages, so include anything that might be referenced later.`,
    },
  ];

  if (existingSummary) {
    messages.push({
      role: 'user',
      content: `Here is the existing conversation summary:\n${existingSummary}\n\nHere are new conversation turns to incorporate:\n${turnTexts}\n\nCreate an updated summary that incorporates all of this information.`,
    });
  } else {
    messages.push({
      role: 'user',
      content: `Summarize the following conversation turns, preserving all key information:\n\n${turnTexts}`,
    });
  }

  return messages;
}
