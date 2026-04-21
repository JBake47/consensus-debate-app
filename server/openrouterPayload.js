function normalizeParts(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

const OPENROUTER_WEB_SEARCH_TOOL_TYPE = 'openrouter:web_search';
const WEB_SEARCH_ENGINES = new Set(['auto', 'native', 'exa', 'firecrawl', 'parallel']);
const SEARCH_CONTEXT_SIZES = new Set(['low', 'medium', 'high']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeDomain(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return null;
  let host = raw;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    host = raw.split('/')[0];
  }
  const normalized = host.replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(normalized) ? normalized : null;
}

function normalizePositiveInteger(value, max = Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(max, Math.floor(parsed));
}

function normalizeDomainList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return Array.from(new Set(values.map(normalizeDomain).filter(Boolean)));
}

function normalizeUserLocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const location = {};
  const locationType = normalizeString(value.type).toLowerCase();
  if (locationType === 'approximate') {
    location.type = locationType;
  }
  for (const key of ['city', 'region', 'country', 'timezone']) {
    const normalized = normalizeString(value[key]);
    if (normalized) location[key] = normalized;
  }
  return Object.keys(location).length > 0 ? location : null;
}

export function buildOpenRouterWebSearchParameters({
  engine,
  maxResults,
  maxTotalResults,
  searchContextSize,
  allowedDomains,
  excludedDomains,
  userLocation,
} = {}) {
  const parameters = {};
  const normalizedEngine = normalizeString(engine).toLowerCase();
  if (WEB_SEARCH_ENGINES.has(normalizedEngine)) {
    parameters.engine = normalizedEngine;
  }

  const normalizedMaxResults = normalizePositiveInteger(maxResults, 25);
  if (normalizedMaxResults != null) {
    parameters.max_results = normalizedMaxResults;
  }

  const normalizedMaxTotalResults = normalizePositiveInteger(maxTotalResults);
  if (normalizedMaxTotalResults != null) {
    parameters.max_total_results = normalizedMaxTotalResults;
  }

  const normalizedContextSize = normalizeString(searchContextSize).toLowerCase();
  if (SEARCH_CONTEXT_SIZES.has(normalizedContextSize)) {
    parameters.search_context_size = normalizedContextSize;
  }

  if (normalizedEngine !== 'firecrawl') {
    const normalizedAllowedDomains = normalizeDomainList(allowedDomains);
    const normalizedExcludedDomains = normalizeDomainList(excludedDomains);
    if (normalizedAllowedDomains.length > 0) {
      parameters.allowed_domains = normalizedAllowedDomains;
    }
    if (
      normalizedExcludedDomains.length > 0
      && (normalizedAllowedDomains.length === 0 || normalizedEngine === 'exa')
    ) {
      parameters.excluded_domains = normalizedExcludedDomains;
    }
  }

  const normalizedUserLocation = normalizeUserLocation(userLocation);
  if (normalizedUserLocation) {
    parameters.user_location = normalizedUserLocation;
  }

  return parameters;
}

export function buildOpenRouterTools({
  nativeWebSearch = false,
  webSearchOptions = {},
} = {}) {
  if (!nativeWebSearch) return [];
  const tool = { type: OPENROUTER_WEB_SEARCH_TOOL_TYPE };
  const parameters = buildOpenRouterWebSearchParameters(webSearchOptions);
  if (Object.keys(parameters).length > 0) {
    tool.parameters = parameters;
  }
  return [tool];
}

export function hasOpenRouterFileParts(messages) {
  return (messages || []).some((message) =>
    normalizeParts(message?.content).some((part) => part?.type === 'file' && part?.file)
  );
}

function buildLegacyWebSearchPlugin(webPluginId, webSearchOptions) {
  const plugin = { id: webPluginId };
  const parameters = buildOpenRouterWebSearchParameters(webSearchOptions);
  if (parameters.engine) plugin.engine = parameters.engine;
  if (parameters.max_results) plugin.max_results = parameters.max_results;
  if (parameters.search_context_size) plugin.search_context_size = parameters.search_context_size;
  if (parameters.allowed_domains?.length) plugin.include_domains = parameters.allowed_domains;
  if (parameters.excluded_domains?.length) plugin.exclude_domains = parameters.excluded_domains;
  return plugin;
}

export function buildOpenRouterPlugins({
  legacyWebSearch = false,
  messages = [],
  webPluginId = 'web',
  filePluginId = 'file-parser',
  pdfEngine = 'pdf-text',
  webSearchOptions = {},
}) {
  const plugins = [];
  if (legacyWebSearch) {
    plugins.push(buildLegacyWebSearchPlugin(webPluginId, webSearchOptions));
  }
  if (hasOpenRouterFileParts(messages)) {
    const filePlugin = { id: filePluginId };
    if (pdfEngine) {
      filePlugin.pdf = { engine: pdfEngine };
    }
    plugins.push(filePlugin);
  }
  return plugins;
}
