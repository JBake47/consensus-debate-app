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
