export const STALE_RUN_ERROR_MESSAGE = 'Run interrupted before completion.';
export const STALE_CONVERGENCE_REASON = 'Convergence check interrupted before completion.';

export function isLiveStatus(status) {
  return status === 'streaming' || status === 'pending' || status === 'searching' || status === 'analyzing';
}

export function getTurnLastRunActivityAt(turn) {
  const parsed = Number(turn?.lastRunActivityAt);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  const timestamp = Number(turn?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return Math.floor(timestamp);
  }
  return 0;
}

export function isTurnActivelyRunning(turn) {
  if (!turn || typeof turn !== 'object') return false;

  const webSearchStatus = turn.webSearchResult?.status;
  if (isLiveStatus(webSearchStatus)) return true;

  const ensembleStatus = turn.ensembleResult?.status;
  if (isLiveStatus(ensembleStatus)) return true;

  const synthesisStatus = turn.synthesis?.status;
  if (synthesisStatus === 'streaming') return true;

  const rounds = Array.isArray(turn.rounds) ? turn.rounds : [];
  if (rounds.length > 0) {
    for (const round of rounds) {
      if (isLiveStatus(round?.status)) return true;
      const streams = Array.isArray(round?.streams) ? round.streams : [];
      for (const stream of streams) {
        if (isLiveStatus(stream?.status)) return true;
      }
    }
  }

  if (synthesisStatus === 'pending' && rounds.length === 0) {
    return true;
  }

  return false;
}

export function isConversationActivelyRunning(conversation) {
  if (!conversation || !Array.isArray(conversation.turns) || conversation.turns.length === 0) {
    return false;
  }
  const lastTurn = conversation.turns[conversation.turns.length - 1];
  return isTurnActivelyRunning(lastTurn);
}

export function getLiveConversationRunScopes(conversations) {
  const items = Array.isArray(conversations) ? conversations : [];
  const scopes = [];

  for (const conversation of items) {
    if (!isConversationActivelyRunning(conversation)) continue;
    const lastTurn = conversation.turns[conversation.turns.length - 1];
    if (!conversation?.id || !lastTurn?.id || !lastTurn?.activeRunId) continue;
    scopes.push({
      conversationId: conversation.id,
      turnId: lastTurn.id,
      runId: lastTurn.activeRunId,
    });
  }

  return scopes;
}

export function recoverInterruptedTurnState(turn) {
  if (!turn || typeof turn !== 'object') {
    return { turn, changed: false };
  }

  let changed = false;
  let nextTurn = turn;

  if (turn.webSearchResult && isLiveStatus(turn.webSearchResult.status)) {
    nextTurn = {
      ...nextTurn,
      webSearchResult: {
        ...turn.webSearchResult,
        status: 'error',
        error: turn.webSearchResult.error || STALE_RUN_ERROR_MESSAGE,
      },
    };
    changed = true;
  }

  if (turn.ensembleResult && isLiveStatus(turn.ensembleResult.status)) {
    if (nextTurn === turn) nextTurn = { ...turn };
    nextTurn.ensembleResult = {
      ...turn.ensembleResult,
      status: 'error',
      error: turn.ensembleResult.error || STALE_RUN_ERROR_MESSAGE,
    };
    changed = true;
  }

  const synthesisStatus = turn.synthesis?.status;
  const isPendingWarmup = synthesisStatus === 'pending'
    && (!Array.isArray(turn.rounds) || turn.rounds.length === 0);
  if (
    turn.synthesis
    && (synthesisStatus === 'streaming' || synthesisStatus === 'searching' || synthesisStatus === 'analyzing' || isPendingWarmup)
  ) {
    if (nextTurn === turn) nextTurn = { ...turn };
    nextTurn.synthesis = {
      ...turn.synthesis,
      status: 'error',
      error: turn.synthesis.error || STALE_RUN_ERROR_MESSAGE,
      retryProgress: null,
    };
    changed = true;
  }

  if (Array.isArray(turn.rounds) && turn.rounds.length > 0) {
    let roundChanged = false;
    const nextRounds = turn.rounds.map((round) => {
      if (!round || typeof round !== 'object') return round;

      let nextRound = round;

      if (isLiveStatus(round.status)) {
        nextRound = { ...nextRound, status: 'error' };
      }

      if (Array.isArray(round.streams) && round.streams.length > 0) {
        let streamChanged = false;
        const nextStreams = round.streams.map((stream) => {
          if (!stream || typeof stream !== 'object') return stream;
          if (!isLiveStatus(stream.status)) return stream;
          streamChanged = true;
          const hasContent = typeof stream.content === 'string' && stream.content.trim().length > 0;
          return {
            ...stream,
            status: hasContent ? 'complete' : 'error',
            error: stream.error || STALE_RUN_ERROR_MESSAGE,
            errorKind: stream.errorKind || 'failed',
            outcome: hasContent ? 'using_previous_response' : (stream.outcome || null),
            retryProgress: null,
          };
        });
        if (streamChanged) {
          if (nextRound === round) nextRound = { ...round };
          nextRound.streams = nextStreams;
        }
      }

      if (nextRound.convergenceCheck && nextRound.convergenceCheck.converged == null) {
        if (nextRound === round) nextRound = { ...round };
        nextRound.convergenceCheck = {
          ...nextRound.convergenceCheck,
          converged: false,
          reason: nextRound.convergenceCheck.reason || STALE_CONVERGENCE_REASON,
        };
      }

      if (nextRound !== round) {
        roundChanged = true;
      }
      return nextRound;
    });

    if (roundChanged) {
      if (nextTurn === turn) nextTurn = { ...turn };
      nextTurn.rounds = nextRounds;
      changed = true;
    }
  }

  if (changed) {
    if (nextTurn === turn) nextTurn = { ...turn };
    nextTurn.activeRunId = null;
  }

  if (
    changed
    && turn.debateMetadata
    && (turn.debateMetadata.terminationReason == null || turn.debateMetadata.terminationReason === '')
  ) {
    if (nextTurn === turn) nextTurn = { ...turn };
    nextTurn.debateMetadata = {
      ...turn.debateMetadata,
      terminationReason: 'interrupted',
    };
  }

  return { turn: nextTurn, changed };
}

export function getResumeRecoveryConversationIds(conversations, options = {}) {
  const items = Array.isArray(conversations) ? conversations : [];
  const hiddenAt = Number(options.hiddenAt);
  const resumedAt = Number(options.resumedAt);
  const minHiddenMs = Number.isFinite(Number(options.minHiddenMs))
    ? Math.max(0, Number(options.minHiddenMs))
    : 0;
  const maxRunInactivityMs = Number.isFinite(Number(options.maxRunInactivityMs))
    ? Math.max(0, Number(options.maxRunInactivityMs))
    : 0;

  if (!Number.isFinite(hiddenAt) || !Number.isFinite(resumedAt) || resumedAt <= hiddenAt) {
    return [];
  }

  if ((resumedAt - hiddenAt) < minHiddenMs) {
    return [];
  }

  return items
    .filter((conversation) => {
      if (!isConversationActivelyRunning(conversation)) return false;
      const lastTurn = conversation.turns[conversation.turns.length - 1];
      const lastActivityAt = getTurnLastRunActivityAt(lastTurn);
      if (!lastActivityAt) return true;
      return (resumedAt - lastActivityAt) >= maxRunInactivityMs;
    })
    .map((conversation) => conversation.id)
    .filter(Boolean);
}

export function resolveInitialActiveConversationId(conversations, storedActiveConversationId) {
  const items = Array.isArray(conversations) ? conversations : [];

  if (storedActiveConversationId === null) {
    return null;
  }

  if (typeof storedActiveConversationId === 'string' && storedActiveConversationId) {
    const exists = items.some((conversation) => conversation.id === storedActiveConversationId);
    if (exists) {
      return storedActiveConversationId;
    }
  }

  return items[0]?.id || null;
}
