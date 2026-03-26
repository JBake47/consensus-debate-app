import assert from 'node:assert/strict';
import {
  createSeedDescription,
  createSeedTitle,
  generateTitle,
  normalizeGeneratedTitle,
} from './titleGenerator.js';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
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

function withMockFetch(mockFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

await runTest('createSeedTitle turns buy-advice questions into compact topic titles', async () => {
  assert.equal(
    createSeedTitle('Which laptop should I buy for local llm work?'),
    'Laptop for Local LLM Work',
  );
});

await runTest('createSeedDescription creates a deterministic fallback summary', async () => {
  assert.equal(
    createSeedDescription('Which laptop should I buy for local llm work?'),
    'Choosing laptop for local LLM work.',
  );
});

await runTest('createSeedTitle removes question phrasing from medical checks', async () => {
  assert.equal(
    createSeedTitle('Is there a drug interaction between sertraline and ibuprofen?'),
    'Drug Interaction Between Sertraline and Ibuprofen',
  );
});

await runTest('createSeedTitle keeps how-to prompts readable', async () => {
  assert.equal(
    createSeedTitle('How do I make a sourdough starter from scratch?'),
    'How to Make a Sourdough Starter from Scratch',
  );
});

await runTest('normalizeGeneratedTitle strips generic lead-in phrases from model output', async () => {
  assert.equal(
    normalizeGeneratedTitle('Title: What are the best laptops for video editing?'),
    'Best Laptops for Video Editing',
  );
});

await runTest('normalizeGeneratedTitle falls back to a deterministic prompt-based title', async () => {
  assert.equal(
    normalizeGeneratedTitle('', 'Can you summarize this quarterly sales report?'),
    'Summary of Quarterly Sales Report',
  );
});

await runTest('createSeedTitle returns a safe default for empty prompts', async () => {
  assert.equal(createSeedTitle('   '), 'New Chat');
});

await runTest('generateTitle fills missing descriptions from deterministic fallback', async () => {
  await withMockFetch(async () => jsonResponse({
    content: '{"title":"Laptop for Local LLM Work"}',
  }), async () => {
    const result = await generateTitle({
      userPrompt: 'Which laptop should I buy for local llm work?',
      synthesisContent: 'A workstation laptop with a large GPU and enough RAM is the best fit.',
      apiKey: 'test-key',
    });
    assert.equal(result.title, 'Laptop for Local LLM Work');
    assert.equal(result.description, 'Choosing laptop for local LLM work.');
  });
});

await runTest('generateTitle parses labelled non-JSON responses', async () => {
  await withMockFetch(async () => jsonResponse({
    content: 'Title: Laptop for Local LLM Work\nDescription: Choosing a laptop for running local language models.',
  }), async () => {
    const result = await generateTitle({
      userPrompt: 'Which laptop should I buy for local llm work?',
      synthesisContent: 'Look for a dedicated GPU and plenty of memory.',
      apiKey: 'test-key',
    });
    assert.equal(result.title, 'Laptop for Local LLM Work');
    assert.equal(result.description, 'Choosing a laptop for running local language models.');
  });
});

await runTest('generateTitle falls back to deterministic title and description on request failure', async () => {
  await withMockFetch(async () => jsonResponse({
    error: { message: 'backend unavailable' },
  }, false, 503), async () => {
    const result = await generateTitle({
      userPrompt: 'How do I make a sourdough starter from scratch?',
      synthesisContent: 'Feed flour and water daily until the starter becomes active.',
      apiKey: 'test-key',
    });
    assert.equal(result.title, 'How to Make a Sourdough Starter from Scratch');
    assert.equal(result.description, 'Learning how to make a sourdough starter from scratch.');
  });
});

// eslint-disable-next-line no-console
console.log('Title generator tests completed.');
