import assert from 'node:assert/strict';
import {
  buildSearchEvidence,
  canUseNativeWebSearch,
  getSearchResponseCachePolicy,
  normalizeSearchMetadata,
  shouldFallbackForMissingSearchEvidence,
} from './webSearch.js';

function runTest(name, fn) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

runTest('normalizeSearchMetadata dedupes structured citations and carries date hints', () => {
  const metadata = normalizeSearchMetadata({
    citations: [
      { url: 'https://example.com/news', title: 'Example', publishedAt: '2026-03-08T12:00:00Z' },
      { url: 'https://example.com/news', title: 'Example' },
    ],
    dateHints: ['2026-03-08T12:00:00Z'],
  });

  assert.equal(metadata.citations.length, 1);
  assert.equal(metadata.citations[0].domain, 'example.com');
  assert.equal(metadata.dateHints.length, 1);
});

runTest('buildSearchEvidence uses structured citations and dates for realtime verification', () => {
  const evidence = buildSearchEvidence({
    prompt: 'What is the latest CPI reading today?',
    content: 'Inflation eased again.',
    strictMode: true,
    searchMetadata: {
      citations: [
        {
          url: 'https://www.bls.gov/news.release/cpi.htm',
          title: 'BLS CPI',
          publishedAt: '2026-03-08T09:30:00Z',
        },
        {
          url: 'https://www.reuters.com/world/us/us-inflation-cools-2026-03-08/',
          title: 'Reuters inflation',
          publishedAt: '2026-03-08T10:15:00Z',
        },
      ],
      dateHints: ['2026-03-08T10:15:00Z'],
    },
    nowMs: Date.parse('2026-03-09T12:00:00Z'),
  });

  assert.equal(evidence.verified, true);
  assert.equal(evidence.structuredCitationCount, 2);
  assert.equal(evidence.verificationMode, 'structured');
  assert.equal(evidence.sourceCount, 2);
  assert.equal(evidence.absoluteDateCount >= 1, true);
});

runTest('getSearchResponseCachePolicy bypasses realtime search cache and shortens other search cache entries', () => {
  const realtime = getSearchResponseCachePolicy({
    prompt: 'What is the latest price right now?',
    searchEnabled: true,
  });
  const evergreen = getSearchResponseCachePolicy({
    prompt: 'Summarize the background of the Paris Agreement.',
    searchEnabled: true,
    defaultTtlMs: 120000,
  });

  assert.equal(realtime.cacheable, false);
  assert.equal(realtime.ttlMs, 0);
  assert.equal(evergreen.cacheable, true);
  assert.equal(evergreen.ttlMs, 30000);
});

runTest('shouldFallbackForMissingSearchEvidence uses a majority threshold', () => {
  const mostlyVerified = shouldFallbackForMissingSearchEvidence([
    { content: 'A', searchEvidence: { canRetryWithLegacy: false } },
    { content: 'B', searchEvidence: { canRetryWithLegacy: false } },
    { content: 'C', searchEvidence: { canRetryWithLegacy: true } },
  ]);
  const majorityUnverified = shouldFallbackForMissingSearchEvidence([
    { content: 'A', searchEvidence: { canRetryWithLegacy: true } },
    { content: 'B', searchEvidence: { canRetryWithLegacy: true } },
    { content: 'C', searchEvidence: { canRetryWithLegacy: false } },
  ]);

  assert.equal(mostlyVerified, false);
  assert.equal(majorityUnverified, true);
});

runTest('canUseNativeWebSearch respects transport provider and conservative model hints', () => {
  const capabilityRegistry = {
    providers: {
      openrouter: { enabled: true, capabilities: { webSearchNative: true } },
      openai: { enabled: true, capabilities: { webSearchNative: true } },
    },
  };
  const providerStatus = { openrouter: true, openai: true };

  assert.equal(
    canUseNativeWebSearch({
      model: 'anthropic/claude-3.7-sonnet',
      providerStatus,
      capabilityRegistry,
      modelCatalog: {},
    }),
    true,
  );
  assert.equal(
    canUseNativeWebSearch({
      model: 'openai:gpt-4.1-mini',
      providerStatus,
      capabilityRegistry,
      modelCatalog: {},
    }),
    false,
  );
  assert.equal(
    canUseNativeWebSearch({
      model: 'openai:gpt-4.1-search-preview',
      providerStatus,
      capabilityRegistry,
      modelCatalog: {},
    }),
    true,
  );
});

// eslint-disable-next-line no-console
console.log('Web search helper tests completed.');
