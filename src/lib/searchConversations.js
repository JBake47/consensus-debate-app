function normalizeSection(section, fallbackTurnIndex = null) {
  if (!section || typeof section !== 'object') return null;
  const text = String(section.text || '').trim();
  if (!text) return null;
  return {
    matchType: String(section.matchType || 'content'),
    text,
    lower: text.toLowerCase(),
    turnIndex: section.turnIndex ?? fallbackTurnIndex,
  };
}

function getSectionsFromSidebarData(conversation) {
  const sidebarData = conversation?.sidebarData;
  if (!sidebarData || typeof sidebarData !== 'object') return null;

  const sections = [];
  for (const section of sidebarData.headerSections || []) {
    const normalized = normalizeSection(section, null);
    if (normalized) sections.push(normalized);
  }

  for (const turnEntry of sidebarData.turnEntries || []) {
    for (const section of turnEntry?.sections || []) {
      const normalized = normalizeSection(section, turnEntry?.turnIndex ?? null);
      if (normalized) sections.push(normalized);
    }
  }

  return sections;
}

function getFallbackSections(conversation) {
  const sections = [];
  const title = String(conversation?.title || '').trim();
  const description = String(conversation?.description || '').trim();

  if (title) {
    sections.push({ matchType: 'title', text: title, lower: title.toLowerCase(), turnIndex: null });
  }

  if (description) {
    sections.push({ matchType: 'description', text: description, lower: description.toLowerCase(), turnIndex: null });
  }

  for (let turnIndex = 0; turnIndex < (conversation?.turns || []).length; turnIndex += 1) {
    const turn = conversation.turns[turnIndex];
    const searchSections = Array.isArray(turn?.searchSections)
      ? turn.searchSections
      : [];

    if (searchSections.length > 0) {
      for (const section of searchSections) {
        const normalized = normalizeSection(section, turnIndex);
        if (normalized) sections.push(normalized);
      }
      continue;
    }

    const prompt = String(turn?.userPrompt || '').trim();
    if (prompt) {
      sections.push({ matchType: 'prompt', text: prompt, lower: prompt.toLowerCase(), turnIndex });
    }

    const synthesis = String(turn?.synthesis?.content || '').trim();
    if (synthesis) {
      sections.push({ matchType: 'synthesis', text: synthesis, lower: synthesis.toLowerCase(), turnIndex });
    }
  }

  return sections;
}

/**
 * Build a lightweight search index from cached sidebar metadata instead of raw
 * chat payloads so searching stays cheap even for large histories.
 */
export function buildConversationSearchIndex(conversations) {
  return [...(Array.isArray(conversations) ? conversations : [])]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((conversation) => {
      const sections = getSectionsFromSidebarData(conversation) || getFallbackSections(conversation);
      return {
        conversationId: conversation?.id,
        conversationTitle: String(conversation?.title || '').trim() || 'Untitled chat',
        updatedAt: conversation?.updatedAt || conversation?.createdAt || 0,
        sections,
      };
    })
    .filter((entry) => entry.conversationId);
}

export function searchConversationIndex(index, query, limit = 50) {
  if (!query || query.length < 2) return [];

  const q = query.toLowerCase();
  const results = [];

  for (const entry of Array.isArray(index) ? index : []) {
    let bestMatch = null;
    for (const section of entry.sections) {
      if (!section.lower.includes(q)) continue;
      bestMatch = {
        conversationId: entry.conversationId,
        conversationTitle: entry.conversationTitle,
        updatedAt: entry.updatedAt,
        matchType: section.matchType,
        snippet: highlightSnippet(section.text, q),
        turnIndex: section.turnIndex,
      };
      break;
    }
    if (bestMatch) {
      results.push(bestMatch);
      if (results.length >= limit) break;
    }
  }

  return results;
}

export function searchConversations(conversations, query, limit = 50) {
  return searchConversationIndex(buildConversationSearchIndex(conversations), query, limit);
}

/**
 * Extract ~60 chars of context around the first match.
 */
export function highlightSnippet(text, query) {
  const safeText = String(text || '');
  const lower = safeText.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return safeText.slice(0, 60);

  const contextRadius = 30;
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(safeText.length, idx + query.length + contextRadius);

  let snippet = '';
  if (start > 0) snippet += '...';
  snippet += safeText.slice(start, end);
  if (end < safeText.length) snippet += '...';

  return snippet;
}
