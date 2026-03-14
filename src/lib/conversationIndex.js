import { getModelDisplayName } from './openrouter.js';

const PROMPT_SECTION_LIMIT = 420;
const RESPONSE_SECTION_LIMIT = 260;
const SYNTHESIS_SECTION_LIMIT = 720;
const CONTEXT_PROMPT_LIMIT = 220;
const CONTEXT_RESPONSE_LIMIT = 240;
const CONTEXT_SYNTHESIS_LIMIT = 1200;
const MAX_CONTEXT_MODEL_SNIPPETS = 3;

function truncateText(text, maxLength) {
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) return '';
  if (!Number.isFinite(maxLength) || maxLength <= 0 || safeText.length <= maxLength) {
    return safeText;
  }
  return `${safeText.slice(0, maxLength)}...`;
}

function getFinalRound(turn) {
  return Array.isArray(turn?.rounds) && turn.rounds.length > 0
    ? turn.rounds[turn.rounds.length - 1]
    : null;
}

function buildAttachmentLabelSummary(turn) {
  if (!Array.isArray(turn?.attachments) || turn.attachments.length === 0) return '';
  const routing = Array.isArray(turn.attachmentRouting) ? turn.attachmentRouting : [];
  return turn.attachments
    .map((attachment, index) => {
      const route = routing[index];
      const label = route?.primaryLabel || 'Attached';
      return `${attachment.name} (${label})`;
    })
    .filter(Boolean)
    .join(', ');
}

function buildFinalRoundSnippets(turn, maxLength, maxItems = Infinity) {
  const finalRound = getFinalRound(turn);
  if (!finalRound) return [];

  return (finalRound.streams || [])
    .filter((stream) => stream?.content && stream.status === 'complete')
    .slice(0, Math.max(0, maxItems))
    .map((stream) => `${getModelDisplayName(stream.model)}: ${truncateText(stream.content, maxLength)}`)
    .filter(Boolean);
}

export function buildTurnContextSummary(turn) {
  if (!turn || typeof turn !== 'object') return '';

  const parts = [];
  const attachmentSummary = buildAttachmentLabelSummary(turn);
  if (attachmentSummary) {
    parts.push(`[Attachments: ${attachmentSummary}]`);
  }

  if (turn.webSearchResult?.content && turn.webSearchResult.status === 'complete') {
    parts.push('[Web search was performed for this query]');
  }

  const modelSnippets = buildFinalRoundSnippets(turn, CONTEXT_RESPONSE_LIMIT, MAX_CONTEXT_MODEL_SNIPPETS);
  if (modelSnippets.length > 0) {
    const finalRound = getFinalRound(turn);
    parts.push(`Model positions (${finalRound?.label || 'Latest round'}):\n${modelSnippets.join('\n')}`);
  }

  if (turn.debateMetadata?.totalRounds > 1) {
    parts.push(
      `[Debate: ${turn.debateMetadata.totalRounds} rounds, ${
        turn.debateMetadata.converged ? 'converged' : (turn.debateMetadata.terminationReason || 'completed')
      }]`,
    );
  }

  if (turn.synthesis?.content && turn.synthesis.status === 'complete') {
    parts.push(`Synthesized answer:\n${truncateText(turn.synthesis.content, CONTEXT_SYNTHESIS_LIMIT)}`);
  } else if (modelSnippets.length === 0) {
    const fallbackPrompt = truncateText(turn.userPrompt, CONTEXT_PROMPT_LIMIT);
    if (fallbackPrompt) {
      parts.push(`Question: ${fallbackPrompt}`);
    }
  }

  return parts.join('\n\n');
}

export function buildTurnSearchSections(turn, turnIndex = null) {
  if (!turn || typeof turn !== 'object') return [];

  const sections = [];
  const prompt = truncateText(turn.userPrompt, PROMPT_SECTION_LIMIT);
  if (prompt) {
    sections.push({ matchType: 'prompt', text: prompt, turnIndex });
  }

  const synthesis = truncateText(turn.synthesis?.content, SYNTHESIS_SECTION_LIMIT);
  if (synthesis) {
    sections.push({ matchType: 'synthesis', text: synthesis, turnIndex });
  }

  for (const snippet of buildFinalRoundSnippets(turn, RESPONSE_SECTION_LIMIT)) {
    sections.push({ matchType: 'response', text: snippet, turnIndex });
  }

  return sections;
}

export function enrichTurnDerivedData(turn, turnIndex = null) {
  if (!turn || typeof turn !== 'object') return turn;

  const contextSummary = buildTurnContextSummary(turn);
  const searchSections = buildTurnSearchSections(turn, turnIndex);

  const sameContext = turn.contextSummary === contextSummary;
  const sameSections = JSON.stringify(turn.searchSections || []) === JSON.stringify(searchSections);
  if (sameContext && sameSections) {
    return turn;
  }

  return {
    ...turn,
    contextSummary,
    searchSections,
  };
}

function buildHeaderSections(conversation) {
  const sections = [];
  const title = truncateText(conversation?.title, PROMPT_SECTION_LIMIT);
  if (title) {
    sections.push({ matchType: 'title', text: title, turnIndex: null });
  }

  const description = truncateText(conversation?.description, PROMPT_SECTION_LIMIT);
  if (description) {
    sections.push({ matchType: 'description', text: description, turnIndex: null });
  }

  return sections;
}

export function buildConversationSidebarData(conversation) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  return {
    headerSections: buildHeaderSections(conversation),
    turnEntries: turns.map((turn, turnIndex) => ({
      turnId: turn?.id || `${turnIndex}`,
      turnIndex,
      sections: Array.isArray(turn?.searchSections)
        ? turn.searchSections.map((section) => ({ ...section, turnIndex }))
        : buildTurnSearchSections(turn, turnIndex),
    })),
  };
}

export function enrichConversationDerivedData(conversation) {
  if (!conversation || typeof conversation !== 'object') return conversation;

  const turns = Array.isArray(conversation.turns)
    ? conversation.turns.map((turn, turnIndex) => enrichTurnDerivedData(turn, turnIndex))
    : [];
  const summarizedTurnCountRaw = Number(conversation.summarizedTurnCount);
  const summarizedTurnCount = Number.isFinite(summarizedTurnCountRaw)
    ? Math.max(0, Math.min(turns.length, Math.floor(summarizedTurnCountRaw)))
    : 0;
  const pendingSummaryUntilTurnRaw = Number(conversation.pendingSummaryUntilTurnCount);
  const pendingSummaryUntilTurnCount = Number.isFinite(pendingSummaryUntilTurnRaw)
    ? Math.max(summarizedTurnCount, Math.min(turns.length, Math.floor(pendingSummaryUntilTurnRaw)))
    : summarizedTurnCount;

  return {
    ...conversation,
    turns,
    summarizedTurnCount,
    pendingSummaryUntilTurnCount,
    sidebarData: buildConversationSidebarData({ ...conversation, turns }),
  };
}

export function updateConversationSidebarHeader(conversation) {
  if (!conversation || typeof conversation !== 'object') return conversation;
  const sidebarData = conversation.sidebarData || { headerSections: [], turnEntries: [] };
  return {
    ...conversation,
    sidebarData: {
      ...sidebarData,
      headerSections: buildHeaderSections(conversation),
    },
  };
}

export function updateConversationLastTurnDerivedData(conversation) {
  if (!conversation || typeof conversation !== 'object') return conversation;
  const turns = Array.isArray(conversation.turns) ? [...conversation.turns] : [];
  if (turns.length === 0) {
    return updateConversationSidebarHeader({
      ...conversation,
      turns,
      summarizedTurnCount: 0,
      pendingSummaryUntilTurnCount: 0,
      sidebarData: { headerSections: buildHeaderSections(conversation), turnEntries: [] },
    });
  }

  const lastTurnIndex = turns.length - 1;
  const enrichedTurn = enrichTurnDerivedData(turns[lastTurnIndex], lastTurnIndex);
  turns[lastTurnIndex] = enrichedTurn;

  const nextConversation = {
    ...conversation,
    turns,
  };
  const sidebarData = conversation.sidebarData || buildConversationSidebarData(nextConversation);
  const turnEntries = Array.isArray(sidebarData.turnEntries) ? [...sidebarData.turnEntries] : [];
  const nextEntry = {
    turnId: enrichedTurn?.id || `${lastTurnIndex}`,
    turnIndex: lastTurnIndex,
    sections: Array.isArray(enrichedTurn.searchSections)
      ? enrichedTurn.searchSections.map((section) => ({ ...section, turnIndex: lastTurnIndex }))
      : buildTurnSearchSections(enrichedTurn, lastTurnIndex),
  };

  if (turnEntries.length === turns.length) {
    turnEntries[lastTurnIndex] = nextEntry;
  } else if (turnEntries.length === turns.length - 1) {
    turnEntries.push(nextEntry);
  } else {
    return enrichConversationDerivedData(nextConversation);
  }

  return updateConversationSidebarHeader({
    ...nextConversation,
    sidebarData: {
      headerSections: buildHeaderSections(nextConversation),
      turnEntries,
    },
  });
}

export function markConversationSummaryProgress(
  conversation,
  summary,
  summarizedTurnCount,
  expectedCurrentPendingTurnCount = null,
) {
  if (!conversation || typeof conversation !== 'object') return conversation;

  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const currentSummarizedTurnCount = Number.isFinite(Number(conversation.summarizedTurnCount))
    ? Math.max(0, Math.min(turns.length, Math.floor(Number(conversation.summarizedTurnCount))))
    : 0;
  const currentPendingTurnCount = Number.isFinite(Number(conversation.pendingSummaryUntilTurnCount))
    ? Math.max(currentSummarizedTurnCount, Math.min(turns.length, Math.floor(Number(conversation.pendingSummaryUntilTurnCount))))
    : currentSummarizedTurnCount;
  const normalizedCount = Number.isFinite(Number(summarizedTurnCount))
    ? Math.max(0, Math.min(turns.length, Math.floor(Number(summarizedTurnCount))))
    : currentSummarizedTurnCount;

  if (
    Number.isFinite(Number(expectedCurrentPendingTurnCount))
    && currentPendingTurnCount !== Math.floor(Number(expectedCurrentPendingTurnCount))
  ) {
    return conversation;
  }

  if (
    normalizedCount < currentSummarizedTurnCount
    || normalizedCount > currentPendingTurnCount
  ) {
    return conversation;
  }

  return {
    ...conversation,
    runningSummary: typeof summary === 'string' ? summary : '',
    summarizedTurnCount: normalizedCount,
    pendingSummaryUntilTurnCount: normalizedCount,
  };
}

export function markConversationSummaryPending(conversation, pendingTurnCount, expectedCurrentPendingTurnCount = null) {
  if (!conversation || typeof conversation !== 'object') return conversation;
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const summarized = Number.isFinite(Number(conversation.summarizedTurnCount))
    ? Math.max(0, Math.min(turns.length, Math.floor(Number(conversation.summarizedTurnCount))))
    : 0;
  const normalizedCount = Number.isFinite(Number(pendingTurnCount))
    ? Math.max(summarized, Math.min(turns.length, Math.floor(Number(pendingTurnCount))))
    : summarized;
  const currentPending = Number.isFinite(Number(conversation.pendingSummaryUntilTurnCount))
    ? Math.max(summarized, Math.min(turns.length, Math.floor(Number(conversation.pendingSummaryUntilTurnCount))))
    : summarized;

  if (
    Number.isFinite(Number(expectedCurrentPendingTurnCount))
    && currentPending !== Math.floor(Number(expectedCurrentPendingTurnCount))
  ) {
    return conversation;
  }

  if (normalizedCount === currentPending) {
    return conversation;
  }

  return {
    ...conversation,
    pendingSummaryUntilTurnCount: normalizedCount,
  };
}

export function buildConversationListItem(conversation) {
  const sidebarData = conversation?.sidebarData || { headerSections: [], turnEntries: [] };
  return {
    id: conversation?.id,
    title: conversation?.title || 'Untitled chat',
    description: conversation?.description || '',
    updatedAt: conversation?.updatedAt || conversation?.createdAt || 0,
    createdAt: conversation?.createdAt || 0,
    turnCount: Array.isArray(conversation?.turns) ? conversation.turns.length : 0,
    sidebarData,
  };
}
