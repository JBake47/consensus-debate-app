function normalizeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getSidebarConversationSortTimestamp(conversation, isRunning = false) {
  const lastTurnTimestamp = normalizeTimestamp(conversation?.lastTurnTimestamp);
  if (isRunning && lastTurnTimestamp > 0) {
    return lastTurnTimestamp;
  }

  const updatedAt = normalizeTimestamp(conversation?.updatedAt);
  if (updatedAt > 0) {
    return updatedAt;
  }

  const createdAt = normalizeTimestamp(conversation?.createdAt);
  if (createdAt > 0) {
    return createdAt;
  }

  return lastTurnTimestamp;
}

export function compareSidebarConversations(a, b, isConversationInProgress = () => false) {
  const aRunning = Boolean(isConversationInProgress(a?.id));
  const bRunning = Boolean(isConversationInProgress(b?.id));
  const aSortTimestamp = getSidebarConversationSortTimestamp(a, aRunning);
  const bSortTimestamp = getSidebarConversationSortTimestamp(b, bRunning);

  if (aSortTimestamp !== bSortTimestamp) {
    return bSortTimestamp - aSortTimestamp;
  }

  const aCreatedAt = normalizeTimestamp(a?.createdAt);
  const bCreatedAt = normalizeTimestamp(b?.createdAt);
  if (aCreatedAt !== bCreatedAt) {
    return bCreatedAt - aCreatedAt;
  }

  return 0;
}

export function sortSidebarConversations(conversations, isConversationInProgress = () => false) {
  return [...(Array.isArray(conversations) ? conversations : [])]
    .sort((a, b) => compareSidebarConversations(a, b, isConversationInProgress));
}

export function getMostRecentConversation(conversations, isConversationInProgress = () => false) {
  const [latestConversation] = sortSidebarConversations(conversations, isConversationInProgress);
  return latestConversation || null;
}

export function isMostRecentConversation(conversations, conversationId, isConversationInProgress = () => false) {
  if (!conversationId) return false;
  return getMostRecentConversation(conversations, isConversationInProgress)?.id === conversationId;
}
