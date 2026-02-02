/**
 * Format a token count for display.
 * "847" or "1.2k" or "12.5k"
 */
export function formatTokenCount(count) {
  if (count == null) return null;
  if (count < 1000) return String(count);
  return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

/**
 * Format a USD cost for display.
 * "$0.0012" or "$0.05" or "$1.23"
 */
export function formatCost(cost) {
  if (cost == null) return null;
  if (cost === 0) return '$0.00';
  if (cost < 0.001) return '<$0.001';
  if (cost < 0.01) return '$' + cost.toFixed(4);
  if (cost < 1) return '$' + cost.toFixed(3);
  return '$' + cost.toFixed(2);
}

/**
 * Aggregate cost from all streams and synthesis in a turn.
 */
export function computeTurnCost(turn) {
  let total = 0;
  if (turn.rounds) {
    for (const round of turn.rounds) {
      for (const stream of round.streams) {
        if (stream.usage?.cost != null) total += stream.usage.cost;
      }
    }
  }
  if (turn.synthesis?.usage?.cost != null) total += turn.synthesis.usage.cost;
  if (turn.ensembleResult?.usage?.cost != null) total += turn.ensembleResult.usage.cost;
  return total;
}

/**
 * Aggregate cost from all turns in a conversation.
 */
export function computeConversationCost(conversation) {
  if (!conversation?.turns) return 0;
  let total = 0;
  for (const turn of conversation.turns) {
    total += computeTurnCost(turn);
  }
  return total;
}

/**
 * Format a duration in milliseconds for display.
 * "340ms" or "3.4s" or "1m 12s"
 */
export function formatDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
