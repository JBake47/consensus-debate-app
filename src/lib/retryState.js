import { rankModels } from './modelRanking.js';

function getProviderKey(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 'unknown';
  if (id.includes(':')) {
    return id.split(':')[0];
  }
  return id.split('/')[0];
}

function formatRetryDelay(delayMs) {
  const normalized = Number(delayMs);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  if (normalized < 1000) return `${Math.ceil(normalized)}ms`;
  const seconds = Math.ceil(normalized / 100) / 10;
  return Number.isInteger(seconds) ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

export function createRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatRetryProgressLabel(retryProgress) {
  if (!retryProgress?.active) return null;
  const attempt = Number.isFinite(Number(retryProgress.attempt))
    ? Math.max(1, Math.floor(Number(retryProgress.attempt)))
    : 1;
  const maxAttempts = Number.isFinite(Number(retryProgress.maxAttempts))
    ? Math.max(attempt, Math.floor(Number(retryProgress.maxAttempts)))
    : attempt;
  const delayLabel = formatRetryDelay(retryProgress.delayMs);
  return delayLabel
    ? `Retrying in ${delayLabel} - attempt ${attempt}/${maxAttempts}`
    : `Retrying - attempt ${attempt}/${maxAttempts}`;
}

export function getStreamDisplayState(stream) {
  const status = stream?.status || 'pending';
  const retryLabel = formatRetryProgressLabel(stream?.retryProgress);
  const hasStaleContent = Boolean(stream?.content) && stream?.completedAt != null;
  const outcome = stream?.outcome || null;
  const errorKind = stream?.errorKind
    || (stream?.searchEvidence?.strictBlocked ? 'strict_blocked' : null);

  if (status === 'streaming') {
    if (retryLabel) {
      return { kind: 'retrying', tone: 'warning', label: retryLabel };
    }
    if (hasStaleContent) {
      return { kind: 'refreshing', tone: 'warning', label: 'Refreshing...' };
    }
    return { kind: 'streaming', tone: 'streaming', label: 'Thinking...' };
  }

  if (status === 'pending') {
    return { kind: 'pending', tone: 'pending', label: 'Waiting...' };
  }

  if (outcome === 'using_previous_response') {
    return { kind: outcome, tone: 'warning', label: 'Using prior answer' };
  }

  if (errorKind === 'strict_blocked') {
    return { kind: errorKind, tone: 'warning', label: 'Blocked' };
  }

  if (errorKind === 'cancelled') {
    return { kind: errorKind, tone: 'warning', label: 'Cancelled' };
  }

  if (status === 'error') {
    return { kind: 'failed', tone: 'error', label: 'Failed' };
  }

  return { kind: 'complete', tone: 'complete', label: 'Complete' };
}

export function deriveRoundStatusFromStreams(streams, fallbackStatus = 'pending') {
  const items = Array.isArray(streams) ? streams.filter(Boolean) : [];
  if (items.length === 0) return fallbackStatus;

  if (items.some((stream) => stream.status === 'streaming')) {
    return 'streaming';
  }

  if (items.some((stream) => stream.status === 'pending')) {
    return fallbackStatus === 'streaming' ? 'streaming' : 'pending';
  }

  const displayStates = items.map(getStreamDisplayState);
  const hasWarnings = displayStates.some((state) => state.tone === 'warning');
  const hardErrors = items.filter((stream) => stream.status === 'error');
  const freshOrStaleContentCount = items.filter((stream) => Boolean(stream.content) && stream.status !== 'error').length;

  if (hardErrors.length > 0 && freshOrStaleContentCount === 0) {
    return 'error';
  }

  if (hasWarnings || hardErrors.length > 0) {
    return 'warning';
  }

  return 'complete';
}

export function isRoundAttentionRequired(round) {
  const derivedStatus = deriveRoundStatusFromStreams(round?.streams || [], round?.status || 'pending');
  if (derivedStatus === 'warning' || derivedStatus === 'error') {
    return true;
  }
  return (round?.streams || []).some((stream) => Boolean(stream?.retryProgress?.active));
}

export function getRetryScopeDescription({
  scope = 'stream',
  mode = 'debate',
  roundNumber = null,
  totalRounds = null,
  modelName = '',
  replacementModelName = '',
  hasFailures = false,
} = {}) {
  const hasRoundNumber = Number.isFinite(Number(roundNumber)) && Number(roundNumber) > 0;
  const safeRoundNumber = hasRoundNumber ? Math.floor(Number(roundNumber)) : null;
  const safeTotalRounds = Number.isFinite(Number(totalRounds)) && Number(totalRounds) >= safeRoundNumber
    ? Math.floor(Number(totalRounds))
    : safeRoundNumber;
  const roundLabel = safeRoundNumber ? `Round ${safeRoundNumber}` : 'this round';
  const tailLabel = safeTotalRounds && safeRoundNumber && safeTotalRounds > safeRoundNumber
    ? `${roundLabel} through Round ${safeTotalRounds}`
    : roundLabel;

  if (scope === 'stream') {
    const subject = replacementModelName
      ? `Replace ${modelName || 'this model'} with ${replacementModelName} in ${roundLabel}.`
      : `Retry ${modelName || 'this model'} in ${roundLabel}.`;

    if (mode === 'parallel') {
      return `${subject} This only refreshes this response.`;
    }
    if (mode === 'direct') {
      return `${subject} This refreshes the round and reruns the synthesized answer.`;
    }
    return `${subject} This rebuilds ${tailLabel} and refreshes the synthesized answer.`;
  }

  if (scope === 'round') {
    const subject = hasFailures
      ? `Retry the incomplete responses in ${roundLabel}.`
      : `Redo ${roundLabel}.`;
    if (mode === 'parallel') {
      return `${subject} This only refreshes that round.`;
    }
    if (mode === 'direct') {
      return `${subject} This reruns the synthesized answer.`;
    }
    return `${subject} This rebuilds ${tailLabel} and refreshes the synthesized answer.`;
  }

  if (scope === 'synthesis') {
    return 'Retry the synthesized answer using the latest completed round responses.';
  }

  if (scope === 'web_search') {
    return 'Retry web search and rebuild from Round 1 with refreshed evidence.';
  }

  return '';
}

export function getReplacementModelChoices({
  currentModel,
  roundModels = [],
  modelCatalog = {},
  metrics = null,
  rankingMode = 'balanced',
  rankingPreferences = null,
} = {}) {
  if (!currentModel || !modelCatalog || Object.keys(modelCatalog).length === 0) {
    return [];
  }

  const ranked = rankModels({
    modelCatalog,
    metrics,
    preferredMode: rankingMode,
    limit: 48,
    rankingPreferences,
  });

  const excluded = new Set(
    Array.isArray(roundModels)
      ? roundModels.filter(Boolean)
      : []
  );
  const currentProvider = getProviderKey(currentModel);
  const candidates = ranked
    .filter((entry) => entry.modelId !== currentModel)
    .map((entry) => ({
      ...entry,
      sameProvider: getProviderKey(entry.modelId) === currentProvider,
      alreadyUsedInRound: excluded.has(entry.modelId),
    }))
    .sort((left, right) => {
      const leftBucket = left.alreadyUsedInRound ? 2 : (left.sameProvider ? 1 : 0);
      const rightBucket = right.alreadyUsedInRound ? 2 : (right.sameProvider ? 1 : 0);
      if (leftBucket !== rightBucket) return leftBucket - rightBucket;
      return right.score - left.score;
    });
  if (candidates.length === 0) {
    return [];
  }

  return candidates.map((entry, index) => ({
    ...entry,
    recommended: index === 0,
  }));
}

export function selectReplacementModel(options = {}) {
  const [replacement] = getReplacementModelChoices(options);
  return replacement?.modelId || null;
}
