function normalizeUrl(rawUrl) {
  const cleaned = String(rawUrl || '').trim().replace(/[),.;]+$/, '');
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeDateHint(rawDate) {
  const value = String(rawDate || '').trim();
  if (!value) return null;
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) ? value : null;
}

function normalizeCitation(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const url = normalizeUrl(
    candidate.url
    || candidate.uri
    || candidate.href
    || candidate.link
    || candidate.web?.url
    || candidate.web?.uri
    || candidate.source?.url
    || candidate.source?.uri
    || candidate.url_citation?.url
  );
  if (!url) return null;

  let domain = '';
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    domain = '';
  }

  return {
    url,
    title: String(
      candidate.title
      || candidate.name
      || candidate.label
      || candidate.web?.title
      || candidate.source?.title
      || candidate.url_citation?.title
      || ''
    ).trim() || null,
    publishedAt: normalizeDateHint(
      candidate.publishedAt
      || candidate.published_at
      || candidate.date
      || candidate.timestamp
      || candidate.updatedAt
      || candidate.updated_at
      || candidate.web?.publishedAt
      || candidate.web?.published_at
      || candidate.url_citation?.published_at
    ),
    snippet: String(
      candidate.snippet
      || candidate.summary
      || candidate.quote
      || candidate.cited_text
      || candidate.citedText
      || candidate.url_citation?.text
      || ''
    ).trim() || null,
    domain,
  };
}

function dedupeStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

export function mergeSearchMetadata(...metadataItems) {
  const citations = [];
  const dateHints = [];
  for (const item of metadataItems) {
    if (!item || typeof item !== 'object') continue;
    for (const citation of item.citations || []) {
      const normalized = normalizeCitation(citation);
      if (normalized) citations.push(normalized);
    }
    for (const hint of item.dateHints || []) {
      const normalized = normalizeDateHint(hint);
      if (normalized) dateHints.push(normalized);
    }
  }

  const dedupedCitations = Array.from(
    citations.reduce((map, citation) => {
      const key = `${citation.url}::${citation.title || ''}`;
      if (!map.has(key)) {
        map.set(key, citation);
        return map;
      }
      const existing = map.get(key);
      if (!existing.publishedAt && citation.publishedAt) {
        map.set(key, citation);
      }
      return map;
    }, new Map()).values()
  );

  return {
    citations: dedupedCitations,
    dateHints: dedupeStrings([
      ...dateHints,
      ...dedupedCitations.map((citation) => citation.publishedAt).filter(Boolean),
    ]),
  };
}

function collectMetadataFromNode(node, path = [], collector = { citations: [], dateHints: [] }) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectMetadataFromNode(item, path, collector);
    }
    return collector;
  }
  if (!node || typeof node !== 'object') return collector;

  const pathText = path.join('.').toLowerCase();
  const relevantPath = /annotation|citation|grounding|source|reference|search|result|document|support/.test(pathText);
  const citation = normalizeCitation(node);
  if (citation && relevantPath) {
    collector.citations.push(citation);
    if (citation.publishedAt) {
      collector.dateHints.push(citation.publishedAt);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && /\b(date|time|timestamp|published|updated|retrieved|posted)\b/i.test(key)) {
      const normalizedDate = normalizeDateHint(value);
      if (normalizedDate) collector.dateHints.push(normalizedDate);
    }
    collectMetadataFromNode(value, [...path, key], collector);
  }
  return collector;
}

function extractGeminiGroundingMetadata(payload) {
  const groundingMetadata = payload?.candidates?.[0]?.groundingMetadata || payload?.groundingMetadata;
  if (!groundingMetadata) return { citations: [], dateHints: [] };

  const citations = [];
  for (const chunk of groundingMetadata.groundingChunks || []) {
    const normalized = normalizeCitation({
      url: chunk?.web?.uri || chunk?.web?.url,
      title: chunk?.web?.title || chunk?.title,
      snippet: chunk?.web?.snippet || chunk?.snippet,
    });
    if (normalized) citations.push(normalized);
  }

  return mergeSearchMetadata({ citations, dateHints: [] }, collectMetadataFromNode(groundingMetadata, ['groundingMetadata']));
}

export function extractSearchMetadata(provider, payload) {
  if (!payload || typeof payload !== 'object') {
    return { citations: [], dateHints: [] };
  }

  if (provider === 'gemini') {
    return extractGeminiGroundingMetadata(payload);
  }

  if (provider === 'openai' || provider === 'openrouter') {
    return mergeSearchMetadata(
      collectMetadataFromNode(payload?.choices?.[0]?.message, ['choices', 'message']),
      collectMetadataFromNode(payload?.choices?.[0]?.delta, ['choices', 'delta']),
      collectMetadataFromNode(payload?.choices?.[0]?.message?.annotations, ['choices', 'message', 'annotations']),
      collectMetadataFromNode(payload?.choices?.[0]?.delta?.annotations, ['choices', 'delta', 'annotations'])
    );
  }

  if (provider === 'anthropic') {
    return mergeSearchMetadata(
      collectMetadataFromNode(payload?.content, ['content']),
      collectMetadataFromNode(payload?.message?.content, ['message', 'content']),
      collectMetadataFromNode(payload?.content_block, ['content_block']),
      collectMetadataFromNode(payload?.delta, ['delta'])
    );
  }

  return collectMetadataFromNode(payload, []);
}
