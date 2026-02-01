/**
 * Search across conversations for a query string.
 * Returns an array of results sorted by recency (updatedAt desc).
 * Each result: { conversationId, conversationTitle, updatedAt, matchType, snippet, turnIndex }
 */
export function searchConversations(conversations, query) {
  if (!query || query.length < 2) return [];

  const q = query.toLowerCase();
  const results = [];

  for (const conv of conversations) {
    let bestMatch = null;

    // Search title
    if (conv.title && conv.title.toLowerCase().includes(q)) {
      bestMatch = {
        conversationId: conv.id,
        conversationTitle: conv.title,
        updatedAt: conv.updatedAt || conv.createdAt || 0,
        matchType: 'title',
        snippet: highlightSnippet(conv.title, q),
        turnIndex: null,
      };
    }

    // Search description
    if (!bestMatch && conv.description && conv.description.toLowerCase().includes(q)) {
      bestMatch = {
        conversationId: conv.id,
        conversationTitle: conv.title,
        updatedAt: conv.updatedAt || conv.createdAt || 0,
        matchType: 'description',
        snippet: highlightSnippet(conv.description, q),
        turnIndex: null,
      };
    }

    // Search turns
    if (conv.turns) {
      for (let ti = 0; ti < conv.turns.length; ti++) {
        const turn = conv.turns[ti];

        // Search user prompt
        if (!bestMatch && turn.userPrompt && turn.userPrompt.toLowerCase().includes(q)) {
          bestMatch = {
            conversationId: conv.id,
            conversationTitle: conv.title,
            updatedAt: conv.updatedAt || conv.createdAt || 0,
            matchType: 'prompt',
            snippet: highlightSnippet(turn.userPrompt, q),
            turnIndex: ti,
          };
        }

        // Search synthesis content
        if (!bestMatch && turn.synthesis?.content && turn.synthesis.content.toLowerCase().includes(q)) {
          bestMatch = {
            conversationId: conv.id,
            conversationTitle: conv.title,
            updatedAt: conv.updatedAt || conv.createdAt || 0,
            matchType: 'synthesis',
            snippet: highlightSnippet(turn.synthesis.content, q),
            turnIndex: ti,
          };
        }

        // Search final round stream content
        if (!bestMatch && turn.rounds && turn.rounds.length > 0) {
          const finalRound = turn.rounds[turn.rounds.length - 1];
          if (finalRound.streams) {
            for (const stream of finalRound.streams) {
              if (stream.content && stream.content.toLowerCase().includes(q)) {
                bestMatch = {
                  conversationId: conv.id,
                  conversationTitle: conv.title,
                  updatedAt: conv.updatedAt || conv.createdAt || 0,
                  matchType: 'response',
                  snippet: highlightSnippet(stream.content, q),
                  turnIndex: ti,
                };
                break;
              }
            }
          }
        }

        if (bestMatch) break;
      }
    }

    if (bestMatch) {
      results.push(bestMatch);
    }
  }

  // Sort by recency
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

/**
 * Extract ~60 chars of context around the first match.
 */
export function highlightSnippet(text, query) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, 60);

  const contextRadius = 30;
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(text.length, idx + query.length + contextRadius);

  let snippet = '';
  if (start > 0) snippet += '...';
  snippet += text.slice(start, end);
  if (end < text.length) snippet += '...';

  return snippet;
}
