export function buildResetSynthesisState(previousSynthesis, model, options = {}) {
  const previous = previousSynthesis && typeof previousSynthesis === 'object'
    ? previousSynthesis
    : null;
  const preserveContent = Boolean(options.preserveContent);
  const previousContent = typeof previous?.content === 'string' ? previous.content : '';
  const keepExistingContent = preserveContent && previousContent.trim().length > 0;

  const nextState = {
    model: model || previous?.model || '',
    content: keepExistingContent ? previousContent : '',
    status: keepExistingContent ? 'streaming' : 'pending',
    error: null,
    retryProgress: null,
  };

  if (keepExistingContent && previous?.usage !== undefined) {
    nextState.usage = previous.usage;
  }
  if (keepExistingContent && previous?.durationMs !== undefined) {
    nextState.durationMs = previous.durationMs;
  }
  if (keepExistingContent && previous?.completedAt !== undefined) {
    nextState.completedAt = previous.completedAt;
  }

  return nextState;
}

export function getSynthesisStreamingLabel(synthesis) {
  if (synthesis?.status !== 'streaming') {
    return null;
  }

  if (synthesis?.retryProgress?.active) {
    const attempt = Number.isFinite(Number(synthesis.retryProgress.attempt))
      ? Math.max(1, Math.floor(Number(synthesis.retryProgress.attempt)))
      : 1;
    const maxAttempts = Number.isFinite(Number(synthesis.retryProgress.maxAttempts))
      ? Math.max(attempt, Math.floor(Number(synthesis.retryProgress.maxAttempts)))
      : attempt;
    const delayMs = Number(synthesis.retryProgress.delayMs);
    const delayLabel = Number.isFinite(delayMs) && delayMs > 0
      ? (delayMs < 1000
        ? `${Math.ceil(delayMs)}ms`
        : `${(Math.ceil(delayMs / 100) / 10).toFixed(delayMs >= 2000 ? 0 : 1).replace(/\.0$/, '')}s`)
      : null;
    return delayLabel
      ? `Retrying in ${delayLabel} - attempt ${attempt}/${maxAttempts}`
      : `Retrying - attempt ${attempt}/${maxAttempts}`;
  }

  const hasCompletedSnapshot = Boolean(synthesis?.content) && synthesis?.completedAt != null;
  return hasCompletedSnapshot ? 'Refreshing...' : 'Synthesizing...';
}
