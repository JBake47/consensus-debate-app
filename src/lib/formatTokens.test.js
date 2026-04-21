import assert from 'node:assert/strict';
import { getUsageCostMeta } from './formatTokens.js';

function test(name, fn) {
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

function installLocalStorage(values) {
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return values[key] || '';
      },
    },
  };
}

test('cost estimates use catalog cache read and write pricing fallbacks', () => {
  installLocalStorage({
    model_catalog_pricing_fallbacks: JSON.stringify({
      'openai/gpt-5.2': {
        inputPerMillion: 10,
        outputPerMillion: 20,
        cacheReadPerMillion: 1,
        cacheWritePerMillion: 5,
      },
    }),
  });

  const meta = getUsageCostMeta({
    promptTokens: 1000,
    completionTokens: 100,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
  }, 'openai/gpt-5.2');

  assert.equal(meta.quality, 'estimated');
  assert.equal(meta.cost, 0.0079);
});
