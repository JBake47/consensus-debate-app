const SEARCH_URL_REGEX = /https?:\/\/[^\s)\]}>"']+/gi;
const SEARCH_ABSOLUTE_DATE_REGEXES = [
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
];
const SEARCH_TIMESTAMP_HINT_REGEXES = [
  /\b(published|updated|timestamp|as of|last updated|posted)\b/gi,
  /\b\d{1,2}:\d{2}\s?(?:am|pm|utc|gmt|est|edt|cst|cdt|pst|pdt)?\b/gi,
];
const REALTIME_PROMPT_REGEX = /\b(today|current|currently|latest|right now|as of|up[- ]to[- ]date|recent|newest)\b/i;
const DATE_QUERY_PROMPT_REGEX = /\b(what(?:'s| is)\s+(?:today(?:'s)?\s+date|the\s+date|today)|what day is it|current date|date today)\b/i;
const DEFAULT_STANDARD_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_SEARCH_CACHE_TTL_MS = 30 * 1000;
const URL_FIELD_REGEX = /\b(url|uri|href|link)\b/i;
const DATE_FIELD_REGEX = /\b(date|time|timestamp|published|updated|retrieved|posted)\b/i;

function collectRegexMatches(text, regexes) {
  const source = String(text || '');
  const values = new Set();
  for (const regex of regexes) {
    const matches = source.match(regex);
    if (!matches) continue;
    for (const match of matches) {
      const cleaned = String(match || '').trim();
      if (cleaned) values.add(cleaned);
    }
  }
  return Array.from(values);
}

export function normalizeUrl(rawUrl) {
  const cleaned = String(rawUrl || '').trim().replace(/[),.;]+$/, '');
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseDateCandidate(candidate) {
  const raw = String(candidate || '').trim().replace(/[),.;]+$/, '');
  if (!raw) return null;
  const normalized = raw.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/, (_m, month, day, year) => `${month}/${day}/20${year}`);
  const parsedMs = Date.parse(normalized);
  if (!Number.isFinite(parsedMs)) return null;
  return parsedMs;
}

function normalizeDateHint(rawDate) {
  const value = String(rawDate || '').trim();
  if (!value) return null;
  return Number.isFinite(parseDateCandidate(value)) ? value : null;
}

function dedupeStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
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
  );
  if (!url) return null;

  const publishedAt = normalizeDateHint(
    candidate.publishedAt
    || candidate.published_at
    || candidate.date
    || candidate.timestamp
    || candidate.updatedAt
    || candidate.updated_at
    || candidate.web?.publishedAt
    || candidate.web?.published_at
    || candidate.source?.publishedAt
    || candidate.source?.published_at
  );

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
      || ''
    ).trim() || null,
    publishedAt,
    snippet: String(
      candidate.snippet
      || candidate.summary
      || candidate.cited_text
      || candidate.citedText
      || candidate.quote
      || ''
    ).trim() || null,
    domain,
  };
}

export function normalizeSearchMetadata(searchMetadata) {
  if (!searchMetadata || typeof searchMetadata !== 'object') {
    return { citations: [], dateHints: [] };
  }

  const citations = [];
  for (const item of searchMetadata.citations || []) {
    const normalized = normalizeCitation(item);
    if (normalized) citations.push(normalized);
  }

  const dedupedCitations = Array.from(
    citations.reduce((map, citation) => {
      const key = `${citation.url}::${citation.title || ''}`;
      if (!map.has(key)) {
        map.set(key, citation);
      } else {
        const existing = map.get(key);
        if (!existing.publishedAt && citation.publishedAt) {
          map.set(key, citation);
        }
      }
      return map;
    }, new Map()).values()
  );

  const dateHints = dedupeStrings([
    ...(searchMetadata.dateHints || []).map(normalizeDateHint).filter(Boolean),
    ...dedupedCitations.map((citation) => citation.publishedAt).filter(Boolean),
  ]);

  return {
    citations: dedupedCitations,
    dateHints,
  };
}

function collectTextUrls(text) {
  return Array.from(
    new Set(
      (String(text || '').match(SEARCH_URL_REGEX) || [])
        .map(normalizeUrl)
        .filter(Boolean)
    )
  );
}

function collectDomains(urls) {
  return Array.from(
    new Set(
      (urls || [])
        .map((url) => {
          try {
            return new URL(url).hostname.replace(/^www\./, '');
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    )
  );
}

export function isRealtimeSearchPrompt(prompt) {
  const text = String(prompt || '');
  return REALTIME_PROMPT_REGEX.test(text) || DATE_QUERY_PROMPT_REGEX.test(text);
}

export function getSearchResponseCachePolicy({
  prompt = '',
  searchEnabled = false,
  defaultTtlMs = DEFAULT_STANDARD_CACHE_TTL_MS,
} = {}) {
  const normalizedDefaultTtlMs = Number.isFinite(Number(defaultTtlMs))
    ? Math.max(0, Math.floor(Number(defaultTtlMs)))
    : DEFAULT_STANDARD_CACHE_TTL_MS;

  if (!searchEnabled) {
    return {
      cacheable: true,
      ttlMs: normalizedDefaultTtlMs,
      reason: 'default',
    };
  }

  if (isRealtimeSearchPrompt(prompt)) {
    return {
      cacheable: false,
      ttlMs: 0,
      reason: 'realtime_prompt',
    };
  }

  return {
    cacheable: true,
    ttlMs: Math.min(normalizedDefaultTtlMs, DEFAULT_SEARCH_CACHE_TTL_MS),
    reason: 'search_enabled',
  };
}

export function buildSearchEvidence({
  prompt,
  content,
  searchMetadata = null,
  strictMode = false,
  mode = 'native',
  fallbackApplied = false,
  fallbackReason = null,
  nowMs = Date.now(),
}) {
  const text = String(content || '');
  const normalizedMetadata = normalizeSearchMetadata(searchMetadata);
  const structuredUrls = normalizedMetadata.citations.map((citation) => citation.url).filter(Boolean);
  const textUrls = collectTextUrls(text);
  const urls = Array.from(new Set([...structuredUrls, ...textUrls]));
  const sources = collectDomains(urls);
  const absoluteDateMentions = dedupeStrings([
    ...normalizedMetadata.dateHints,
    ...collectRegexMatches(text, SEARCH_ABSOLUTE_DATE_REGEXES),
  ]);
  const dateEpochs = absoluteDateMentions.map(parseDateCandidate).filter(Number.isFinite);
  const timestampMentions = dedupeStrings([
    ...normalizedMetadata.dateHints,
    ...collectRegexMatches(text, SEARCH_TIMESTAMP_HINT_REGEXES),
  ]);
  const realtimeIntent = REALTIME_PROMPT_REGEX.test(String(prompt || ''));
  const explicitDateQuery = DATE_QUERY_PROMPT_REGEX.test(String(prompt || ''));
  const requiredSources = strictMode ? 2 : 1;
  const requiredAbsoluteDates = realtimeIntent ? 1 : 0;
  const requiredTimestampHints = strictMode && realtimeIntent ? 1 : 0;
  const freshnessWindowDays = explicitDateQuery ? 1 : 45;

  const issues = [];
  if (sources.length < requiredSources) {
    issues.push(`Only ${sources.length} source${sources.length === 1 ? '' : 's'} detected.`);
  }
  if (requiredAbsoluteDates > 0 && dateEpochs.length < requiredAbsoluteDates) {
    issues.push('Missing absolute date evidence.');
  }
  if (requiredTimestampHints > 0 && timestampMentions.length < requiredTimestampHints) {
    issues.push('Missing publication timestamp cues.');
  }

  let staleDays = null;
  if (realtimeIntent && dateEpochs.length > 0) {
    const newestDate = Math.max(...dateEpochs);
    staleDays = Math.floor((nowMs - newestDate) / (24 * 60 * 60 * 1000));
    if (staleDays > freshnessWindowDays) {
      issues.push(`Latest cited date appears stale (${staleDays} days old).`);
    }
  }

  const searchUsed = (
    urls.length > 0
    || timestampMentions.length > 0
    || dateEpochs.length > 0
    || normalizedMetadata.citations.length > 0
  );
  const verified = issues.length === 0;
  let verificationMode = 'text';
  if (normalizedMetadata.citations.length > 0 && textUrls.length > 0) {
    verificationMode = 'hybrid';
  } else if (normalizedMetadata.citations.length > 0) {
    verificationMode = 'structured';
  } else if (!searchUsed) {
    verificationMode = 'none';
  }

  return {
    mode,
    searchUsed,
    verified,
    strictMode,
    sourceCount: sources.length,
    sources,
    urlCount: urls.length,
    urls,
    absoluteDateCount: absoluteDateMentions.length,
    timestampCount: timestampMentions.length,
    realtimeIntent,
    staleDays,
    issues,
    primaryIssue: issues[0] || null,
    fallbackApplied,
    fallbackReason,
    canRetryWithLegacy: !verified,
    checkedAt: nowMs,
    verificationMode,
    structuredCitationCount: normalizedMetadata.citations.length,
    structuredCitations: normalizedMetadata.citations,
  };
}

export function shouldFallbackForMissingSearchEvidence(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  const completed = results.filter((result) => result && !result.error && result.content);
  if (completed.length === 0) return false;
  const evidenceResults = completed.filter((result) => result.searchEvidence);
  if (evidenceResults.length === 0) return false;
  const retryableCount = evidenceResults.filter((result) => result.searchEvidence?.canRetryWithLegacy).length;
  return retryableCount >= Math.ceil(evidenceResults.length / 2);
}

function getTransportProviderId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return 'openrouter';
  if (raw.startsWith('openrouter/')) return 'openrouter';
  const colonIndex = raw.indexOf(':');
  if (colonIndex > 0) {
    const prefix = raw.slice(0, colonIndex);
    if (prefix === 'openai' || prefix === 'anthropic' || prefix === 'openrouter') return prefix;
    if (prefix === 'gemini' || prefix === 'google') return 'gemini';
  }
  return 'openrouter';
}

function collectModelCatalogKeys(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return [];
  const provider = getTransportProviderId(raw);
  const keys = new Set([raw]);
  if (provider !== 'openrouter' && raw.includes(':')) {
    const rest = raw.slice(raw.indexOf(':') + 1);
    keys.add(`${provider}/${rest}`);
    if (provider === 'gemini') {
      keys.add(`google/${rest}`);
    }
  }
  if (provider === 'openrouter' && raw.startsWith('openrouter/')) {
    keys.add(raw.slice('openrouter/'.length));
  }
  return Array.from(keys);
}

function findModelInfo(modelId, modelCatalog) {
  if (!modelCatalog || typeof modelCatalog !== 'object') return null;
  for (const key of collectModelCatalogKeys(modelId)) {
    if (modelCatalog[key]) return modelCatalog[key];
  }
  const lookup = new Map(Object.entries(modelCatalog).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of collectModelCatalogKeys(modelId).map((value) => value.toLowerCase())) {
    if (lookup.has(key)) return lookup.get(key) || null;
  }
  return null;
}

function collectSupportedParameters(modelInfo) {
  const candidates = [
    modelInfo?.supported_parameters,
    modelInfo?.supportedParameters,
    modelInfo?.capabilities?.supported_parameters,
    modelInfo?.capabilities?.supportedParameters,
    modelInfo?.capabilities?.parameters,
    modelInfo?.architecture?.supported_parameters,
  ];
  const result = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      result.push(...candidate);
      continue;
    }
    if (typeof candidate === 'string') {
      result.push(...candidate.split(','));
      continue;
    }
    if (typeof candidate === 'object') {
      result.push(...Object.keys(candidate));
    }
  }
  return result
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function collectNativeSearchSignals(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') return [];
  const values = [
    ...collectSupportedParameters(modelInfo),
    ...Object.keys(modelInfo.capabilities || {}).map((key) => String(key || '').toLowerCase()),
  ];
  return values.filter(Boolean);
}

export function canUseNativeWebSearch({
  model,
  providerStatus = {},
  capabilityRegistry = null,
  modelCatalog = null,
} = {}) {
  const transportProvider = getTransportProviderId(model);
  const providerEnabled = Boolean(
    providerStatus?.[transportProvider]
    ?? capabilityRegistry?.providers?.[transportProvider]?.enabled
  );
  if (!providerEnabled) return false;

  const providerCapabilities = capabilityRegistry?.providers?.[transportProvider]?.capabilities || {};
  if (providerCapabilities.webSearchNative === false) return false;

  if (transportProvider === 'openrouter') {
    return providerCapabilities.webSearchNative !== false;
  }

  const modelInfo = findModelInfo(model, modelCatalog);
  const capabilityHints = collectNativeSearchSignals(modelInfo);
  if (capabilityHints.some((hint) => (
    hint.includes('web_search')
    || hint.includes('web-search')
    || hint.includes('google_search')
    || hint.includes('search_grounding')
  ))) {
    return true;
  }

  const modelId = String(model || '').trim().toLowerCase();
  if (transportProvider === 'openai') {
    return /\bsearch\b/.test(modelId);
  }
  if (transportProvider === 'anthropic') {
    return /\bclaude[-./ ]?(3[-. ]?7|4)\b/.test(modelId);
  }
  if (transportProvider === 'gemini') {
    return /\bgemini[-./ ]?(1\.5|2|2\.5)\b/.test(modelId) || /\b(flash|pro)\b/.test(modelId);
  }
  return false;
}

export function extractStructuredSearchMetadata(payload) {
  const citations = [];
  const dateHints = [];

  const visit = (node, path = []) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, path);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;

    const pathText = path.join('.').toLowerCase();
    const relevantPath = (
      /annotation|citation|grounding|source|reference|search|result|document|support/.test(pathText)
      || path.some((segment) => URL_FIELD_REGEX.test(segment))
    );
    const candidate = normalizeCitation(node);
    if (candidate && relevantPath) {
      citations.push(candidate);
      if (candidate.publishedAt) {
        dateHints.push(candidate.publishedAt);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && DATE_FIELD_REGEX.test(key)) {
        const normalizedDate = normalizeDateHint(value);
        if (normalizedDate) dateHints.push(normalizedDate);
      }
      visit(value, [...path, key]);
    }
  };

  visit(payload);
  return normalizeSearchMetadata({ citations, dateHints });
}
