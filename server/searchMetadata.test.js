import assert from 'node:assert/strict';
import { extractSearchMetadata, mergeSearchMetadata } from './searchMetadata.js';

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

runTest('extractSearchMetadata collects OpenAI URL citations', () => {
  const metadata = extractSearchMetadata('openai', {
    choices: [{
      message: {
        annotations: [
          {
            type: 'url_citation',
            url_citation: {
              url: 'https://example.com/report',
              title: 'Example report',
              published_at: '2026-03-08T12:00:00Z',
            },
          },
        ],
      },
    }],
  });

  assert.equal(metadata.citations.length, 1);
  assert.equal(metadata.citations[0].url, 'https://example.com/report');
  assert.equal(metadata.dateHints.length, 1);
});

runTest('extractSearchMetadata collects Gemini grounding citations', () => {
  const metadata = extractSearchMetadata('gemini', {
    candidates: [{
      groundingMetadata: {
        groundingChunks: [
          {
            web: {
              uri: 'https://example.com/grounding',
              title: 'Grounding source',
            },
          },
        ],
      },
    }],
  });

  assert.equal(metadata.citations.length, 1);
  assert.equal(metadata.citations[0].domain, 'example.com');
});

runTest('mergeSearchMetadata dedupes citations and date hints', () => {
  const metadata = mergeSearchMetadata(
    {
      citations: [{ url: 'https://example.com/a', title: 'A' }],
      dateHints: ['2026-03-08T12:00:00Z'],
    },
    {
      citations: [{ url: 'https://example.com/a', title: 'A', publishedAt: '2026-03-08T12:00:00Z' }],
      dateHints: ['2026-03-08T12:00:00Z'],
    }
  );

  assert.equal(metadata.citations.length, 1);
  assert.equal(metadata.dateHints.length, 1);
});

// eslint-disable-next-line no-console
console.log('Search metadata tests completed.');
