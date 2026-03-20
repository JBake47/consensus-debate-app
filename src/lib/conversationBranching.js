function cloneStructuredData(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

export function buildBranchTitle(title, label = 'Branch') {
  const baseTitle = String(title || '').trim() || 'Debate';
  const suffix = String(label || '').trim() || 'Branch';
  return `${baseTitle} (${suffix})`;
}

export function createConversationHistoryBranch(sourceConversation, {
  branchConversationId,
  createdAt = Date.now(),
  titleLabel = 'Branch',
  titleSource = 'seed',
  branchKind = 'branch',
} = {}) {
  if (!sourceConversation || typeof sourceConversation !== 'object') {
    return null;
  }

  const turns = cloneStructuredData(Array.isArray(sourceConversation.turns) ? sourceConversation.turns : []);
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const nextConversationId = String(branchConversationId || '').trim()
    || `${createdAt}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    ...sourceConversation,
    id: nextConversationId,
    title: buildBranchTitle(sourceConversation.title, titleLabel),
    titleSource,
    titleLocked: false,
    titleEditedAt: null,
    createdAt,
    updatedAt: createdAt,
    parentConversationId: sourceConversation.id || null,
    branchedFrom: {
      branchKind,
      sourceTurnId: lastTurn?.id || null,
    },
    turns,
  };
}
