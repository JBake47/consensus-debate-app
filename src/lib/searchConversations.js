/**
 * Build a lightweight search index so sidebar queries do not rescan the full
 * conversation tree and repeatedly lowercase large strings on every keypress.
 */
export function buildConversationSearchIndex(conversations) {
  return [...(Array.isArray(conversations) ? conversations : [])]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((conv) => {
      const sections = [];
      const title = String(conv?.title || '').trim();
      const description = String(conv?.description || '').trim();

      if (title) {
        sections.push({ matchType: 'title', text: title, lower: title.toLowerCase(), turnIndex: null });
      }

      if (description) {
        sections.push({ matchType: 'description', text: description, lower: description.toLowerCase(), turnIndex: null });
      }

      for (let turnIndex = 0; turnIndex < (conv?.turns || []).length; turnIndex += 1) {
        const turn = conv.turns[turnIndex];
        const prompt = String(turn?.userPrompt || '').trim();
        if (prompt) {
          sections.push({ matchType: 'prompt', text: prompt, lower: prompt.toLowerCase(), turnIndex });
        }

        const synthesis = String(turn?.synthesis?.content || '').trim();
        if (synthesis) {
          sections.push({ matchType: 'synthesis', text: synthesis, lower: synthesis.toLowerCase(), turnIndex });
        }

        const finalRound = Array.isArray(turn?.rounds) && turn.rounds.length > 0
          ? turn.rounds[turn.rounds.length - 1]
          : null;

        for (const stream of finalRound?.streams || []) {
          const response = String(stream?.content || '').trim();
          if (!response) continue;
          sections.push({ matchType: 'response', text: response, lower: response.toLowerCase(), turnIndex });
        }
      }

      return {
        conversationId: conv?.id,
        conversationTitle: title || 'Untitled chat',
        updatedAt: conv?.updatedAt || conv?.createdAt || 0,
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
