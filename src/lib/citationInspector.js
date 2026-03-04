const RAW_URL_REGEX = /https?:\/\/[^\s)\]}>"']+/gi;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi;

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

export function extractCitations(text, supplementalUrls = []) {
  const source = String(text || '');
  const matches = [];

  for (const match of source.matchAll(MARKDOWN_LINK_REGEX)) {
    const label = String(match[1] || '').trim();
    const normalized = normalizeUrl(match[2]);
    if (!normalized) continue;
    matches.push({
      url: normalized,
      label: label || null,
      index: Number.isFinite(match.index) ? match.index : -1,
      kind: 'markdown',
    });
  }

  for (const match of source.matchAll(RAW_URL_REGEX)) {
    const normalized = normalizeUrl(match[0]);
    if (!normalized) continue;
    matches.push({
      url: normalized,
      label: null,
      index: Number.isFinite(match.index) ? match.index : -1,
      kind: 'raw',
    });
  }

  for (const extra of supplementalUrls || []) {
    const normalized = normalizeUrl(extra);
    if (!normalized) continue;
    matches.push({
      url: normalized,
      label: null,
      index: -1,
      kind: 'evidence',
    });
  }

  const deduped = new Map();
  for (const item of matches) {
    if (!deduped.has(item.url)) {
      deduped.set(item.url, item);
      continue;
    }
    const previous = deduped.get(item.url);
    if (!previous.label && item.label) {
      deduped.set(item.url, item);
    }
  }

  return Array.from(deduped.values()).map((item) => {
    let domain = '';
    let path = '';
    try {
      const parsed = new URL(item.url);
      domain = parsed.hostname.replace(/^www\./, '');
      path = parsed.pathname || '/';
    } catch {
      // noop
    }
    return {
      ...item,
      domain,
      path,
    };
  });
}
