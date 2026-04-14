const DEFAULT_CONVERSATION_STORE_STRATEGY = 'balanced';
const MAX_DELETED_CONVERSATION_TOMBSTONES = 500;

function normalizeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeConversationId(value) {
  return String(value || '').trim();
}

function getLastTurn(conversation) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

function getTurnCount(conversation) {
  return Array.isArray(conversation?.turns) ? conversation.turns.length : 0;
}

function getLastTurnTimestamp(conversation) {
  const lastTurn = getLastTurn(conversation);
  return (
    normalizeTimestamp(lastTurn?.lastRunActivityAt)
    || normalizeTimestamp(lastTurn?.completedAt)
    || normalizeTimestamp(lastTurn?.timestamp)
  );
}

function hasActiveRun(conversation) {
  const lastTurn = getLastTurn(conversation);
  return Boolean(lastTurn?.activeRunId);
}

export function getConversationRevisionTimestamp(conversation) {
  return (
    normalizeTimestamp(conversation?.updatedAt)
    || getLastTurnTimestamp(conversation)
    || normalizeTimestamp(conversation?.createdAt)
  );
}

function compareConversations(left, right) {
  const revisionDiff = getConversationRevisionTimestamp(left) - getConversationRevisionTimestamp(right);
  if (revisionDiff !== 0) return revisionDiff;

  const turnCountDiff = getTurnCount(left) - getTurnCount(right);
  if (turnCountDiff !== 0) return turnCountDiff;

  const lastTurnDiff = getLastTurnTimestamp(left) - getLastTurnTimestamp(right);
  if (lastTurnDiff !== 0) return lastTurnDiff;

  const activeRunDiff = Number(hasActiveRun(left)) - Number(hasActiveRun(right));
  if (activeRunDiff !== 0) return activeRunDiff;

  return 0;
}

function selectPreferredConversation(left, right) {
  if (!left) return right;
  if (!right) return left;
  return compareConversations(left, right) > 0 ? left : right;
}

export function normalizeDeletedConversationTombstones(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([conversationId, deletedAt]) => [normalizeConversationId(conversationId), normalizeTimestamp(deletedAt)])
      .filter(([conversationId, deletedAt]) => conversationId && deletedAt > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_DELETED_CONVERSATION_TOMBSTONES)
  );
}

function mergeDeletedConversationTombstones(left, right) {
  const merged = {
    ...normalizeDeletedConversationTombstones(left),
    ...normalizeDeletedConversationTombstones(right),
  };

  for (const [conversationId, deletedAt] of Object.entries(normalizeDeletedConversationTombstones(left))) {
    const current = normalizeTimestamp(merged[conversationId]);
    if (deletedAt > current) {
      merged[conversationId] = deletedAt;
    }
  }

  for (const [conversationId, deletedAt] of Object.entries(normalizeDeletedConversationTombstones(right))) {
    const current = normalizeTimestamp(merged[conversationId]);
    if (deletedAt > current) {
      merged[conversationId] = deletedAt;
    }
  }

  return normalizeDeletedConversationTombstones(merged);
}

function isConversationDeleted(conversation, tombstones) {
  const conversationId = normalizeConversationId(conversation?.id);
  if (!conversationId) return false;
  const deletedAt = normalizeTimestamp(tombstones?.[conversationId]);
  if (!deletedAt) return false;
  return deletedAt >= getConversationRevisionTimestamp(conversation);
}

function sortMergedConversations(left, right) {
  const revisionDiff = getConversationRevisionTimestamp(right) - getConversationRevisionTimestamp(left);
  if (revisionDiff !== 0) return revisionDiff;

  const createdAtDiff = normalizeTimestamp(right?.createdAt) - normalizeTimestamp(left?.createdAt);
  if (createdAtDiff !== 0) return createdAtDiff;

  return normalizeConversationId(left?.id).localeCompare(normalizeConversationId(right?.id));
}

function resolveMergedActiveConversationId(base, incoming, validConversationIds) {
  const preferIncoming = incoming.savedAt >= base.savedAt;
  const primaryActiveConversationId = preferIncoming
    ? incoming.activeConversationId
    : base.activeConversationId;
  const fallbackActiveConversationId = preferIncoming
    ? base.activeConversationId
    : incoming.activeConversationId;

  if (primaryActiveConversationId === null) {
    return null;
  }
  if (validConversationIds.has(primaryActiveConversationId)) {
    return primaryActiveConversationId;
  }
  if (fallbackActiveConversationId === null) {
    return null;
  }
  if (validConversationIds.has(fallbackActiveConversationId)) {
    return fallbackActiveConversationId;
  }
  return null;
}

export function normalizeConversationStoreSnapshot(snapshot) {
  const conversations = Array.isArray(snapshot?.conversations)
    ? snapshot.conversations.filter((conversation) => normalizeConversationId(conversation?.id))
    : [];
  const activeConversationId = normalizeConversationId(snapshot?.activeConversationId) || null;

  return {
    savedAt: normalizeTimestamp(snapshot?.savedAt),
    strategy: typeof snapshot?.strategy === 'string' && snapshot.strategy
      ? snapshot.strategy
      : DEFAULT_CONVERSATION_STORE_STRATEGY,
    activeConversationId,
    conversations,
    deletedConversationTombstones: normalizeDeletedConversationTombstones(
      snapshot?.deletedConversationTombstones,
    ),
  };
}

export function addConversationDeletionTombstone(tombstones, conversationId, deletedAt = Date.now()) {
  const normalizedConversationId = normalizeConversationId(conversationId);
  if (!normalizedConversationId) {
    return normalizeDeletedConversationTombstones(tombstones);
  }

  return normalizeDeletedConversationTombstones({
    ...normalizeDeletedConversationTombstones(tombstones),
    [normalizedConversationId]: normalizeTimestamp(deletedAt) || Date.now(),
  });
}

export function removeConversationDeletionTombstones(tombstones, conversationIds) {
  const next = { ...normalizeDeletedConversationTombstones(tombstones) };
  let changed = false;

  for (const conversationId of Array.isArray(conversationIds) ? conversationIds : []) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId || !Object.prototype.hasOwnProperty.call(next, normalizedConversationId)) {
      continue;
    }
    delete next[normalizedConversationId];
    changed = true;
  }

  return changed ? normalizeDeletedConversationTombstones(next) : normalizeDeletedConversationTombstones(tombstones);
}

export function mergeConversationStoreSnapshots(baseSnapshot, incomingSnapshot) {
  const base = normalizeConversationStoreSnapshot(baseSnapshot);
  const incoming = normalizeConversationStoreSnapshot(incomingSnapshot);
  const tombstones = mergeDeletedConversationTombstones(
    base.deletedConversationTombstones,
    incoming.deletedConversationTombstones,
  );
  const conversationsById = new Map();

  for (const conversation of base.conversations) {
    conversationsById.set(normalizeConversationId(conversation.id), conversation);
  }

  for (const conversation of incoming.conversations) {
    const conversationId = normalizeConversationId(conversation.id);
    conversationsById.set(
      conversationId,
      selectPreferredConversation(conversationsById.get(conversationId), conversation),
    );
  }

  const conversations = Array.from(conversationsById.values())
    .filter((conversation) => !isConversationDeleted(conversation, tombstones))
    .sort(sortMergedConversations);

  const validConversationIds = new Set(conversations.map((conversation) => normalizeConversationId(conversation.id)));
  const activeConversationId = resolveMergedActiveConversationId(
    base,
    incoming,
    validConversationIds,
  );

  return {
    savedAt: Math.max(base.savedAt, incoming.savedAt),
    strategy: incoming.savedAt >= base.savedAt ? incoming.strategy : base.strategy,
    activeConversationId,
    conversations,
    deletedConversationTombstones: tombstones,
  };
}

export function buildConversationStoreSnapshotSignature(snapshot) {
  const normalized = normalizeConversationStoreSnapshot(snapshot);
  const conversationSignature = normalized.conversations
    .map((conversation) => (
      `${normalizeConversationId(conversation.id)}:`
      + `${getConversationRevisionTimestamp(conversation)}:`
      + `${getTurnCount(conversation)}:`
      + `${normalizeTimestamp(conversation?.titleEditedAt)}`
    ))
    .sort()
    .join('|');
  const tombstoneSignature = Object.entries(normalized.deletedConversationTombstones)
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([conversationId, deletedAt]) => `${conversationId}:${deletedAt}`)
    .join('|');

  return `${normalized.activeConversationId || ''}||${conversationSignature}||${tombstoneSignature}`;
}
