import { createHash } from 'node:crypto';

export const DEFAULT_MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MODEL_CATALOG_CACHE_MAX_ENTRIES = 32;
export const DEFAULT_MODEL_CATALOG_CACHE_PENDING_TTL_MS = 30 * 1000;

function normalizePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function buildApiKeyCacheKey(apiKey) {
  return createHash('sha256').update(String(apiKey || '').trim()).digest('hex');
}

function normalizeProviderFilter(value) {
  const provider = String(value || '').trim().toLowerCase();
  return provider === 'gemini' ? 'google' : provider;
}

export function filterModelCatalog(models, options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  const provider = normalizeProviderFilter(options.provider);
  const parsedLimit = Number(options.limit);
  const parsedOffset = Number(options.offset);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(Math.floor(parsedLimit), 0), 500)
    : 200;
  const offset = Number.isFinite(parsedOffset)
    ? Math.max(Math.floor(parsedOffset), 0)
    : 0;

  let filtered = Array.isArray(models) ? models.slice() : [];

  if (provider) {
    filtered = filtered.filter((model) => {
      const id = String(model?.id || '').toLowerCase();
      return id.startsWith(`${provider}/`);
    });
  }

  if (query) {
    filtered = filtered.filter((model) => {
      const haystack = [
        model?.id,
        model?.name,
        model?.description,
      ]
        .map((value) => String(value || '').toLowerCase())
        .join('\n');
      return haystack.includes(query);
    });
  }

  return {
    data: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

export function createModelCatalogCache({
  ttlMs = DEFAULT_MODEL_CATALOG_CACHE_TTL_MS,
  maxEntries = DEFAULT_MODEL_CATALOG_CACHE_MAX_ENTRIES,
  pendingTtlMs = DEFAULT_MODEL_CATALOG_CACHE_PENDING_TTL_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cache = new Map();
  const entryLimit = normalizePositiveInteger(maxEntries, DEFAULT_MODEL_CATALOG_CACHE_MAX_ENTRIES, 1, 5000);
  const pendingTtl = normalizePositiveInteger(pendingTtlMs, DEFAULT_MODEL_CATALOG_CACHE_PENDING_TTL_MS, 1000, 10 * 60 * 1000);

  function prune(now = Date.now()) {
    for (const [key, entry] of cache.entries()) {
      if (!entry) {
        cache.delete(key);
        continue;
      }
      if (entry.promise) {
        if ((entry.startedAt || 0) + pendingTtl <= now) {
          cache.delete(key);
        }
        continue;
      }
      if (entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
  }

  function enforceEntryLimit() {
    while (cache.size > entryLimit) {
      let oldestKey = null;
      let oldestAccessedAt = Infinity;
      for (const [key, entry] of cache.entries()) {
        const accessedAt = Number(entry?.lastAccessedAt || entry?.expiresAt || 0);
        if (accessedAt < oldestAccessedAt) {
          oldestKey = key;
          oldestAccessedAt = accessedAt;
        }
      }
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  }

  async function load(apiKey) {
    if (!apiKey) {
      throw new Error('Missing OpenRouter API key');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('Fetch implementation is unavailable');
    }

    const response = await fetchImpl('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(bodyText || 'Failed to fetch models');
    }

    const data = await response.json();
    return Array.isArray(data?.data) ? data.data : [];
  }

  async function get(apiKey, options = {}) {
    const normalizedApiKey = String(apiKey || '').trim();
    const key = buildApiKeyCacheKey(normalizedApiKey);
    const refresh = options.refresh === true;
    const now = Date.now();
    prune(now);

    const cached = cache.get(key);
    if (!refresh) {
      if (cached?.data && cached.expiresAt > now) {
        cached.lastAccessedAt = now;
        return cached.data;
      }
      if (cached?.promise) {
        cached.lastAccessedAt = now;
        return cached.promise;
      }
    }

    const request = load(normalizedApiKey)
      .then((models) => {
        if (cache.get(key)?.promise === request) {
          const resolvedAt = Date.now();
          cache.set(key, {
            data: models,
            expiresAt: resolvedAt + ttlMs,
            lastAccessedAt: resolvedAt,
            promise: null,
          });
          enforceEntryLimit();
        }
        return models;
      })
      .catch((error) => {
        const latest = cache.get(key);
        if (latest?.promise === request) {
          cache.delete(key);
        }
        throw error;
      });

    cache.set(key, {
      data: null,
      expiresAt: 0,
      startedAt: now,
      lastAccessedAt: now,
      promise: request,
    });
    enforceEntryLimit();

    return request;
  }

  return {
    get,
    clear() {
      cache.clear();
    },
    get size() {
      prune();
      return cache.size;
    },
  };
}
