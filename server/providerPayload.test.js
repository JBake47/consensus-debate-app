import assert from 'node:assert/strict';
import {
  buildAnthropicChatBody,
  buildGeminiGenerateContentBody,
  buildOpenAIChatBody,
  buildOpenRouterChatBody,
  stripOpenRouterPdfFileParts,
} from './providerPayload.js';

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

test('OpenRouter body applies Claude cache control and strips PDF file parser parts', () => {
  const body = buildOpenRouterChatBody({
    model: 'anthropic/claude-sonnet-4.5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(5000) },
          { type: 'file', file: { filename: 'brief.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK' } },
        ],
      },
    ],
    stream: true,
    nativeWebSearch: true,
    webSearchOptions: { engine: 'exa', maxResults: 4, maxTotalResults: 8 },
    promptCache: { enabled: true, claudeTtl: '1h' },
    pluginOptions: { webPluginId: 'web', filePluginId: 'file-parser', pdfEngine: 'pdf-text' },
  });

  assert.equal(body.model, 'anthropic/claude-sonnet-4.5');
  assert.equal(body.stream, true);
  assert.equal(body.include_reasoning, true);
  assert.equal(body.cache_control, undefined);
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(body.tools, [
    { type: 'openrouter:web_search', parameters: { engine: 'exa', max_results: 4, max_total_results: 8 } },
  ]);
  assert.equal(body.messages[0].content.some((part) => part?.type === 'file'), false);
  assert.equal(body.plugins, undefined);
});

test('OpenRouter PDF scrubber replaces file-only messages with an explanatory text part', () => {
  const messages = stripOpenRouterPdfFileParts([{
    role: 'user',
    content: [
      { type: 'file', file: { filename: 'scan.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK' } },
    ],
  }]);

  assert.equal(messages[0].content.length, 1);
  assert.equal(messages[0].content[0].type, 'text');
  assert.match(messages[0].content[0].text, /native PDF parsing is disabled/);
});

test('OpenRouter body can fall back to deprecated web plugin compatibility mode', () => {
  const body = buildOpenRouterChatBody({
    model: 'openai/gpt-5.2',
    messages: [{ role: 'user', content: 'What happened today?' }],
    stream: false,
    nativeWebSearch: true,
    openRouterWebSearchMode: 'plugin',
    webSearchOptions: { maxResults: 3 },
    pluginOptions: { webPluginId: 'web' },
  });

  assert.equal(body.tools, undefined);
  assert.deepEqual(body.plugins, [{ id: 'web', max_results: 3 }]);
});

test('Anthropic body separates system content and preserves explicit breakpoints', () => {
  const body = buildAnthropicChatBody({
    model: 'claude-sonnet-4.5',
    messages: [
      { role: 'system', content: 'System A' },
      { role: 'system', content: 'System B' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reference', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Question' },
        ],
      },
    ],
    stream: false,
    nativeWebSearch: true,
    promptCache: { enabled: true, claudeTtl: '1h' },
    maxTokens: 1234,
  });

  assert.equal(body.system, 'System A\n\nSystem B');
  assert.equal(body.max_tokens, 1234);
  assert.equal(body.cache_control, undefined);
  assert.deepEqual(body.messages[0].content[0], {
    type: 'text',
    text: 'Reference',
    cache_control: { type: 'ephemeral' },
  });
  assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search' }]);
  assert.deepEqual(body.tool_choice, { type: 'auto' });
});

test('Anthropic body applies automatic Claude cache control to a content block', () => {
  const body = buildAnthropicChatBody({
    model: 'claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'x'.repeat(5000) }],
    promptCache: { enabled: true, claudeTtl: '1h' },
  });

  assert.equal(body.cache_control, undefined);
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('Anthropic body falls back when max token config is malformed', () => {
  const body = buildAnthropicChatBody({
    model: 'claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'Question' }],
    maxTokens: 'not-a-number',
  });

  assert.equal(body.max_tokens, 64000);
});

test('OpenAI body uses prompt cache key and existing web-search tool mode', () => {
  const body = buildOpenAIChatBody({
    model: 'gpt-5.1',
    messages: [{ role: 'user', content: 'x'.repeat(5000) }],
    stream: true,
    nativeWebSearch: true,
    promptCache: { enabled: true, openaiRetention: '24h' },
    webSearchMode: 'tools',
  });

  assert.match(body.prompt_cache_key, /^consensus-[a-f0-9]{32}$/);
  assert.equal(body.prompt_cache_retention, '24h');
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.equal(body.tool_choice, 'auto');
});

test('Gemini body converts chat messages and includes cachedContent when supplied', () => {
  const body = buildGeminiGenerateContentBody({
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Prior answer' },
    ],
    nativeWebSearch: true,
    cachedContent: 'cachedContents/abc123',
  });

  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'System prompt' }] });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'Question' }] },
    { role: 'model', parts: [{ text: 'Prior answer' }] },
  ]);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.equal(body.cachedContent, 'cachedContents/abc123');
});
