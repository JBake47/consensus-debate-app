function cloneStructuredData(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function normalizeBranchText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeRoundIndex(value) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeSummaryCount(turnCount, value, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(turnCount, Math.floor(parsed)));
}

function getConversationSummaryState(conversation, turnCount, { invalidate = false } = {}) {
  if (invalidate) {
    return {
      runningSummary: '',
      summarizedTurnCount: 0,
      pendingSummaryUntilTurnCount: 0,
    };
  }

  const summarizedTurnCount = normalizeSummaryCount(
    turnCount,
    conversation?.summarizedTurnCount,
  );
  const pendingSummaryUntilTurnCount = normalizeSummaryCount(
    turnCount,
    conversation?.pendingSummaryUntilTurnCount,
    summarizedTurnCount,
  );

  return {
    runningSummary: typeof conversation?.runningSummary === 'string'
      ? conversation.runningSummary
      : '',
    summarizedTurnCount,
    pendingSummaryUntilTurnCount,
  };
}

export function buildBranchTitle(title, label = 'Branch') {
  const baseTitle = String(title || '').trim() || 'Debate';
  const suffix = String(label || '').trim() || 'Branch';
  return `${baseTitle} (${suffix})`;
}

export function shouldCreateConversationHistoryBranch({
  isMostRecent = false,
  forceBranch = false,
} = {}) {
  return Boolean(forceBranch || !isMostRecent);
}

export function getBranchSourceSummary(branchedFrom) {
  if (!branchedFrom || typeof branchedFrom !== 'object') {
    return null;
  }

  const explicitSummary = normalizeBranchText(branchedFrom.sourceSummary);
  if (explicitSummary) {
    return explicitSummary;
  }

  const sourceStage = normalizeBranchText(branchedFrom.sourceStage)?.toLowerCase() || null;
  const sourceRoundIndex = normalizeRoundIndex(branchedFrom.sourceRoundIndex);
  const branchKind = normalizeBranchText(branchedFrom.branchKind)?.toLowerCase() || 'branch';

  if (sourceStage === 'synthesis') {
    return branchKind === 'retry' ? 'Retry Synthesis' : 'After Synthesized Answer';
  }

  if (sourceStage === 'round') {
    const roundLabel = sourceRoundIndex != null ? `Round ${sourceRoundIndex + 1}` : 'Round';
    if (branchKind === 'retry') {
      return `Retry ${roundLabel}`;
    }
    return `After ${roundLabel}`;
  }

  if (sourceStage === 'turn') {
    if (branchKind === 'edit') {
      return 'Edited Last Prompt';
    }
    if (branchKind === 'retry') {
      return 'Retry Turn';
    }
    return 'After Turn';
  }

  if (branchKind === 'checkpoint') {
    return 'Checkpoint';
  }
  if (branchKind === 'retry') {
    return 'Retry Branch';
  }
  if (branchKind === 'edit') {
    return 'Edited Prompt';
  }
  return 'Branch';
}

export function describeConversationBranch(branchedFrom, parentTitle = '') {
  if (!branchedFrom || typeof branchedFrom !== 'object') {
    return null;
  }

  const branchKind = normalizeBranchText(branchedFrom.branchKind)?.toLowerCase() || 'branch';
  const badgeLabel = getBranchSourceSummary(branchedFrom);
  const parentLabel = normalizeBranchText(parentTitle);
  const kindLabel = branchKind === 'checkpoint'
    ? 'Checkpoint branch'
    : branchKind === 'retry'
      ? 'Retry branch'
      : branchKind === 'edit'
        ? 'Edit branch'
        : 'Branch';

  return {
    badgeLabel,
    parentLabel,
    caption: parentLabel ? `from ${parentLabel}` : kindLabel,
    tooltip: parentLabel
      ? `${kindLabel} from ${parentLabel}${badgeLabel ? ` • ${badgeLabel}` : ''}`
      : `${kindLabel}${badgeLabel ? ` • ${badgeLabel}` : ''}`,
  };
}

export function buildConversationSnapshotWithoutLastTurn(conversation) {
  if (!conversation || typeof conversation !== 'object') {
    return null;
  }

  const sourceTurns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const turns = sourceTurns.slice(0, -1);
  const currentSummarizedTurnCount = normalizeSummaryCount(
    sourceTurns.length,
    conversation.summarizedTurnCount,
  );
  const currentPendingSummaryUntilTurnCount = normalizeSummaryCount(
    sourceTurns.length,
    conversation.pendingSummaryUntilTurnCount,
    currentSummarizedTurnCount,
  );
  const summaryTouchesRemovedTurn = currentSummarizedTurnCount > turns.length
    || currentPendingSummaryUntilTurnCount > turns.length;

  return {
    ...conversation,
    turns,
    ...getConversationSummaryState(conversation, turns.length, {
      invalidate: summaryTouchesRemovedTurn,
    }),
  };
}

export function createConversationHistoryBranch(sourceConversation, {
  branchConversationId,
  createdAt = Date.now(),
  titleLabel = 'Branch',
  titleSource = 'seed',
  branchKind = 'branch',
  sourceStage = null,
  sourceRoundIndex = null,
  sourceSummary = null,
  turnsOverride = null,
  sourceTurnId = null,
} = {}) {
  if (!sourceConversation || typeof sourceConversation !== 'object') {
    return null;
  }

  const sourceTurns = Array.isArray(sourceConversation.turns) ? sourceConversation.turns : [];
  const sourceLastTurn = sourceTurns.length > 0 ? sourceTurns[sourceTurns.length - 1] : null;
  const turns = cloneStructuredData(Array.isArray(turnsOverride) ? turnsOverride : sourceTurns);
  const normalizedBranchKind = normalizeBranchText(branchKind)?.toLowerCase() || 'branch';
  const normalizedSourceStage = normalizeBranchText(sourceStage)?.toLowerCase() || null;
  const normalizedSourceRoundIndex = normalizeRoundIndex(sourceRoundIndex);
  const normalizedSourceSummary = normalizeBranchText(sourceSummary);
  const normalizedSourceTurnId = normalizeBranchText(sourceTurnId)
    || normalizeBranchText(sourceLastTurn?.id);
  const nextConversationId = String(branchConversationId || '').trim()
    || `${createdAt}-${Math.random().toString(36).slice(2, 10)}`;
  const summaryState = getConversationSummaryState(sourceConversation, turns.length, {
    invalidate: Array.isArray(turnsOverride),
  });

  return {
    ...sourceConversation,
    id: nextConversationId,
    title: buildBranchTitle(sourceConversation.title, titleLabel),
    titleSource,
    titleLocked: false,
    titleEditedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...summaryState,
    parentConversationId: sourceConversation.id || null,
    branchedFrom: {
      branchKind: normalizedBranchKind,
      sourceTurnId: normalizedSourceTurnId,
      sourceStage: normalizedSourceStage,
      sourceRoundIndex: normalizedSourceRoundIndex,
      sourceSummary: normalizedSourceSummary,
    },
    turns,
  };
}
