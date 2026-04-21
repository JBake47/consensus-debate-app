import assert from 'node:assert/strict';
import {
  buildOpenRouterPlugins,
  buildOpenRouterTools,
  buildOpenRouterWebSearchParameters,
  hasOpenRouterFileParts,
} from './openrouterPayload.js';
import {
  buildClaudePromptCacheControl,
  buildOpenAIPromptCacheOptions,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
} from './promptCache.js';

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

test('OpenRouter builders separate web search server tools from file parser plugins', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Review this file.' },
        { type: 'file', file: { filename: 'brief.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK' } },
      ],
    },
  ];
  const tools = buildOpenRouterTools({ nativeWebSearch: true });
  const plugins = buildOpenRouterPlugins({
    messages,
    filePluginId: 'file-parser',
    pdfEngine: 'mistral-ocr',
  });
  assert.deepEqual(tools, [{ type: 'openrouter:web_search' }]);
  assert.deepEqual(plugins, [
    { id: 'file-parser', pdf: { engine: 'mistral-ocr' } },
  ]);
});

test('OpenRouter web search parameters normalize server-tool options', () => {
  assert.deepEqual(
    buildOpenRouterWebSearchParameters({
      engine: 'EXA',
      maxResults: 50,
      maxTotalResults: '12',
      searchContextSize: 'HIGH',
      allowedDomains: 'https://www.arxiv.org/search, nature.com',
      excludedDomains: ['reddit.com', 'reddit.com'],
      userLocation: {
        type: 'approximate',
        city: 'New York',
        country: 'US',
        ignored: 'field',
      },
    }),
    {
      engine: 'exa',
      max_results: 25,
      max_total_results: 12,
      search_context_size: 'high',
      allowed_domains: ['arxiv.org', 'nature.com'],
      excluded_domains: ['reddit.com'],
      user_location: {
        type: 'approximate',
        city: 'New York',
        country: 'US',
      },
    }
  );
});

test('OpenRouter web search parameters avoid engine-incompatible domain filters', () => {
  assert.deepEqual(
    buildOpenRouterWebSearchParameters({
      engine: 'parallel',
      allowedDomains: ['example.com'],
      excludedDomains: ['reddit.com'],
    }),
    { engine: 'parallel', allowed_domains: ['example.com'] }
  );
  assert.deepEqual(
    buildOpenRouterWebSearchParameters({
      engine: 'firecrawl',
      allowedDomains: ['example.com'],
      excludedDomains: ['reddit.com'],
    }),
    { engine: 'firecrawl' }
  );
});

test('OpenRouter plugin builder keeps legacy web plugin available for compatibility retry', () => {
  const plugins = buildOpenRouterPlugins({
    legacyWebSearch: true,
    webPluginId: 'web',
    webSearchOptions: {
      engine: 'exa',
      maxResults: 3,
      allowedDomains: ['example.com'],
    },
  });

  assert.deepEqual(plugins, [
    { id: 'web', engine: 'exa', max_results: 3, include_domains: ['example.com'] },
  ]);
});

test('File part detector ignores plain text messages', () => {
  assert.equal(hasOpenRouterFileParts([{ role: 'user', content: 'Hello' }]), false);
  assert.equal(hasOpenRouterFileParts([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]), false);
});

test('Claude prompt cache control is gated by model family and estimated prompt length', () => {
  assert.equal(
    buildClaudePromptCacheControl({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'x'.repeat(10000) }],
    }),
    null,
  );
  assert.equal(
    buildClaudePromptCacheControl({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'short' }],
    }),
    null,
  );
  assert.deepEqual(
    buildClaudePromptCacheControl({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'x'.repeat(5000) }],
      ttl: '1h',
    }),
    { type: 'ephemeral', ttl: '1h' },
  );
  assert.equal(
    buildClaudePromptCacheControl({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x'.repeat(5000), cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'Summarize it.' },
          ],
        },
      ],
      ttl: '1h',
    }),
    null,
  );
});

test('OpenAI prompt cache options include a stable key for eligible long prompts', () => {
  const options = buildOpenAIPromptCacheOptions({
    model: 'gpt-5.1',
    messages: [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'x'.repeat(5000) },
    ],
    retention: '24h',
  });
  assert.match(options.prompt_cache_key, /^consensus-[a-f0-9]{32}$/);
  assert.equal(options.prompt_cache_retention, '24h');
  const reusablePrompt = '**Reusable reference material:**\n' + 'x'.repeat(5000);
  const firstKey = buildOpenAIPromptCacheOptions({
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: `${reusablePrompt}\n\n---\n**User request:**\nQuestion A?` }],
  }).prompt_cache_key;
  const secondKey = buildOpenAIPromptCacheOptions({
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: `${reusablePrompt}\n\n---\n**User request:**\nQuestion B?` }],
  }).prompt_cache_key;
  assert.equal(firstKey, secondKey);
  assert.deepEqual(
    buildOpenAIPromptCacheOptions({
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'short' }],
    }),
    {},
  );
  assert.equal(
    buildOpenAIPromptCacheOptions({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x'.repeat(5000) }],
      retention: 'in_memory',
    }).prompt_cache_retention,
    'in_memory',
  );
  assert.equal(
    buildOpenAIPromptCacheOptions({
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'x'.repeat(5000) }],
      retention: '24h',
    }).prompt_cache_retention,
    undefined,
  );
});

test('Anthropic usage normalization preserves cache read and write token counts', () => {
  const usage = normalizeAnthropicUsage({
    input_tokens: 50,
    cache_read_input_tokens: 1800,
    cache_creation_input_tokens: 200,
    output_tokens: 300,
  });
  assert.equal(usage.prompt_tokens, 2050);
  assert.equal(usage.completion_tokens, 300);
  assert.equal(usage.total_tokens, 2350);
  assert.equal(usage.cache_read_input_tokens, 1800);
  assert.equal(usage.cache_creation_input_tokens, 200);
});

test('Anthropic streaming usage merge keeps cache fields when output deltas arrive later', () => {
  const started = mergeAnthropicUsage(null, {
    input_tokens: 25,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
  });
  const completed = mergeAnthropicUsage(started, { output_tokens: 125 });
  assert.equal(completed.prompt_tokens, 1025);
  assert.equal(completed.completion_tokens, 125);
  assert.equal(completed.total_tokens, 1150);
  assert.equal(completed.cache_read_input_tokens, 1000);
  assert.equal(mergeAnthropicUsage({ cost: 0.01 }, { output_tokens: 1 }).cost, 0.01);
});
