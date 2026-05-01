export function shouldRunConvergenceCheck(roundNum, maxRounds, includeFinalRound) {
  const parsedRound = Number(roundNum);
  const parsedMax = Number(maxRounds);
  if (!Number.isFinite(parsedRound) || !Number.isFinite(parsedMax)) return false;
  const safeRound = Math.floor(parsedRound);
  const safeMax = Math.floor(parsedMax);
  if (safeRound < 2 || safeRound > safeMax) return false;
  if (safeRound < safeMax) return true;
  return Boolean(includeFinalRound) && safeRound === safeMax;
}

export function isConvergenceCheckIncomplete(convergenceCheck) {
  if (!convergenceCheck || typeof convergenceCheck !== 'object') return true;
  if (convergenceCheck.converged == null) return true;
  const reason = String(convergenceCheck.reason || '').trim().toLowerCase();
  return (
    reason === 'checking'
    || reason === 'checking...'
    || reason.includes('interrupted before completion')
  );
}

function hasCompletedAllRoundStreams(round) {
  const streams = Array.isArray(round?.streams) ? round.streams : [];
  return streams.length > 0 && streams.every((stream) => (
    typeof stream?.content === 'string'
    && stream.content.trim().length > 0
    && stream.status === 'complete'
  ));
}

export function shouldResumeDebateBeforeSynthesis(turn, {
  maxRounds,
  includeFinalRound = true,
} = {}) {
  if (!turn || turn.mode === 'direct' || turn.mode === 'parallel') return false;
  const rounds = Array.isArray(turn.rounds) ? turn.rounds : [];
  if (rounds.length === 0) return false;

  const latestRound = rounds[rounds.length - 1];
  if (!hasCompletedAllRoundStreams(latestRound)) return false;

  const roundNum = Number.isFinite(Number(latestRound.roundNumber))
    ? Math.floor(Number(latestRound.roundNumber))
    : rounds.length;
  const parsedMaxRounds = Number(maxRounds);
  if (!Number.isFinite(parsedMaxRounds) || parsedMaxRounds < roundNum) return false;

  const needsConvergenceCheck = shouldRunConvergenceCheck(roundNum, parsedMaxRounds, includeFinalRound)
    && isConvergenceCheckIncomplete(latestRound.convergenceCheck);
  if (needsConvergenceCheck) return true;

  const interruptedBeforeNextRound = turn.debateMetadata?.terminationReason === 'interrupted'
    && roundNum >= 2
    && roundNum < Math.floor(parsedMaxRounds)
    && latestRound.convergenceCheck?.converged === false;

  return interruptedBeforeNextRound;
}
