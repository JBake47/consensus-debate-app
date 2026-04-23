import assert from 'node:assert/strict';
import { createModelCatalogCache, filterModelCatalog } from './modelCatalog.js';

function jsonResponse(body) {
  return {
    ok: true,
    async json() {
      return body;
    },
  };
}

async function runTest(name, fn) {
  try {
    await fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

await runTest('filterModelCatalog filters by provider, query, and pagination', async () => {
  const models = [
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast multimodal model' },
    { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', description: 'Small OpenAI model' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Large Google model' },
  ];

  const filtered = filterModelCatalog(models, {
    provider: 'gemini',
    query: 'flash',
    limit: 10,
    offset: 0,
  });

  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.data.map((model) => model.id), [
    'google/gemini-2.5-flash',
  ]);
});

await runTest('model catalog cache reuses the same fetched result before expiry', async () => {
  let fetchCount = 0;
  const cache = createModelCatalogCache({
    ttlMs: 60_000,
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({
        data: [
          { id: 'anthropic/claude-sonnet-4.5' },
        ],
      });
    },
  });

  const first = await cache.get('test-key');
  const second = await cache.get('test-key');

  assert.equal(fetchCount, 1);
  assert.equal(first, second);
  assert.deepEqual(second, [{ id: 'anthropic/claude-sonnet-4.5' }]);
});

await runTest('model catalog cache dedupes concurrent in-flight fetches', async () => {
  let fetchCount = 0;
  const cache = createModelCatalogCache({
    ttlMs: 60_000,
    fetchImpl: async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({
        data: [
          { id: 'openai/gpt-4.1' },
        ],
      });
    },
  });

  const [first, second] = await Promise.all([
    cache.get('shared-key'),
    cache.get('shared-key'),
  ]);

  assert.equal(fetchCount, 1);
  assert.equal(first, second);
  assert.deepEqual(first, [{ id: 'openai/gpt-4.1' }]);
});

await runTest('model catalog cache caps entries without leaking raw keys into identity', async () => {
  const seenAuthHeaders = [];
  const cache = createModelCatalogCache({
    ttlMs: 60_000,
    maxEntries: 1,
    fetchImpl: async (_url, options = {}) => {
      seenAuthHeaders.push(options.headers?.Authorization || '');
      return jsonResponse({
        data: [
          { id: `model-${seenAuthHeaders.length}` },
        ],
      });
    },
  });

  await cache.get('first-secret-key');
  await cache.get('second-secret-key');

  assert.equal(cache.size, 1);
  assert.deepEqual(seenAuthHeaders, [
    'Bearer first-secret-key',
    'Bearer second-secret-key',
  ]);
});
