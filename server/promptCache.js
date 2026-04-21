import { createHash } from 'node:crypto';

const CHARS_PER_TOKEN = 4;
const OPENAI_PROMPT_CACHE_MIN_TOKENS = 1024;
const PROMPT_CACHE_KEY_TEXT_CHARS = 8192;
const OPENAI_EXTENDED_PROMPT_CACHE_PATTERNS = [
  /^gpt-5\.1(?:-(?:chat-latest|codex(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?|\d{4}-\d{2}-\d{2}))?$/,
  /^gpt-5(?:-(?:codex(?:-\d{4}-\d{2}-\d{2})?|\d{4}-\d{2}-\d{2}))?$/,
  /^gpt-4\.1(?:-\d{4}-\d{2}-\d{2})?$/,
];

function toFiniteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeModelId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (raw.startsWith('openrouter/')) return raw.slice('openrouter/'.length);
  if (raw.includes(':')) return raw.slice(raw.indexOf(':') + 1);
  return raw;
}

function normalizeCacheTtl(ttl) {
  const value = String(ttl || '').trim().toLowerCase();
  return value === '1h' ? '1h' : '';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return part.text || '';
      if (part.type === 'file') return part.file?.filename || '';
      if (part.type === 'image_url') return part.image_url?.url ? '[image]' : '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function hasExplicitCacheControl(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => (
    part
    && typeof part === 'object'
    && part.cache_control
    && typeof part.cache_control === 'object'
  ));
}

function stableTextForPromptCacheKey(content) {
  const text = textFromContent(content).trim();
  const variableMarker = '\n\n---\n**User request:**';
  const markerIndex = text.indexOf(variableMarker);
  if (markerIndex > 0) {
    return text.slice(0, markerIndex).trim();
  }
  return text.slice(0, PROMPT_CACHE_KEY_TEXT_CHARS).trim();
}

export function estimateMessagesTokens(messages = []) {
  if (!Array.isArray(messages)) return 0;
  const chars = messages.reduce((sum, message) => sum + textFromContent(message?.content).length + 16, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function hasPromptCacheBreakpoints(messages = []) {
  return Array.isArray(messages) && messages.some((message) => hasExplicitCacheControl(message?.content));
}

export function isClaudeModel(modelId) {
  const model = normalizeModelId(modelId);
  return model.startsWith('anthropic/') || model.startsWith('claude-') || model.includes('/claude-');
}

export function isOpenAIPromptCacheModel(modelId) {
  const model = normalizeModelId(modelId).replace(/^openai\//, '');
  return (
    model.startsWith('gpt-4o') ||
    model.startsWith('gpt-4.1') ||
    model.startsWith('gpt-5') ||
    /^o[134](?:-|$)/.test(model) ||
    model.startsWith('chatgpt-')
  );
}

export function supportsOpenAIExtendedPromptCache(modelId) {
  const model = normalizeModelId(modelId).replace(/^openai\//, '');
  return OPENAI_EXTENDED_PROMPT_CACHE_PATTERNS.some((pattern) => pattern.test(model));
}

export function getClaudePromptCacheMinTokens(modelId) {
  const model = normalizeModelId(modelId);
  if (/\b(opus[-/]?4[-.]?[567]|haiku[-/]?4[-.]?5)\b/.test(model)) return 4096;
  if (/\b(sonnet[-/]?4[-.]?6|haiku[-/]?3[-.]?5)\b/.test(model)) return 2048;
  return 1024;
}

export function getGeminiPromptCacheMinTokens(modelId) {
  const model = normalizeModelId(modelId);
  if (model.includes('flash')) return 1024;
  return 4096;
}

export function buildEphemeralCacheControl(ttl = '') {
  const normalizedTtl = normalizeCacheTtl(ttl);
  return normalizedTtl ? { type: 'ephemeral', ttl: normalizedTtl } : { type: 'ephemeral' };
}

export function buildClaudePromptCacheControl({
  model,
  messages,
  enabled = true,
  ttl = '',
} = {}) {
  if (!enabled || !isClaudeModel(model)) return null;
  if (hasPromptCacheBreakpoints(messages)) return null;
  const estimatedTokens = estimateMessagesTokens(messages);
  if (estimatedTokens < getClaudePromptCacheMinTokens(model)) return null;
  return buildEphemeralCacheControl(ttl);
}

function getFirstMessageText(messages, predicate) {
  if (!Array.isArray(messages)) return '';
  const found = messages.find((message) => predicate(message) && stableTextForPromptCacheKey(message?.content));
  return found ? stableTextForPromptCacheKey(found.content) : '';
}

export function buildPromptCacheKey(messages = []) {
  const firstSystem = getFirstMessageText(messages, (message) => message?.role === 'system' || message?.role === 'developer');
  const firstUser = getFirstMessageText(messages, (message) => message?.role !== 'system' && message?.role !== 'developer');
  const seed = `${firstSystem}\n---\n${firstUser}`;
  if (!seed.trim()) return null;
  return `consensus-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

export function buildOpenAIPromptCacheOptions({
  model,
  messages,
  enabled = true,
  retention = '',
} = {}) {
  if (!enabled || !isOpenAIPromptCacheModel(model)) return {};
  if (estimateMessagesTokens(messages) < OPENAI_PROMPT_CACHE_MIN_TOKENS) return {};

  const promptCacheKey = buildPromptCacheKey(messages);
  if (!promptCacheKey) return {};

  const options = { prompt_cache_key: promptCacheKey };
  const normalizedRetention = String(retention || '').trim().toLowerCase();
  if (normalizedRetention === 'in_memory' || normalizedRetention === 'in-memory') {
    options.prompt_cache_retention = 'in_memory';
  } else if (normalizedRetention === '24h' && supportsOpenAIExtendedPromptCache(model)) {
    options.prompt_cache_retention = '24h';
  }
  return options;
}

export function normalizeAnthropicUsage(rawUsage = {}) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const inputTokens = toFiniteNumber(rawUsage.input_tokens);
  const cacheReadTokens = toFiniteNumber(rawUsage.cache_read_input_tokens);
  const cacheCreationTokens = toFiniteNumber(rawUsage.cache_creation_input_tokens);
  const outputTokens = toFiniteNumber(rawUsage.output_tokens);
  const promptTokens = [inputTokens, cacheReadTokens, cacheCreationTokens]
    .filter((value) => value != null)
    .reduce((sum, value) => sum + value, 0);
  const hasPrompt = inputTokens != null || cacheReadTokens != null || cacheCreationTokens != null;
  const totalTokens = hasPrompt || outputTokens != null
    ? (hasPrompt ? promptTokens : 0) + (outputTokens || 0)
    : null;

  return {
    prompt_tokens: hasPrompt ? promptTokens : null,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
    cost: rawUsage.cost ?? rawUsage.total_cost ?? null,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_creation: rawUsage.cache_creation || null,
  };
}

export function mergeAnthropicUsage(previousUsage, rawUsage) {
  const nextUsage = normalizeAnthropicUsage(rawUsage);
  if (!nextUsage) return previousUsage || null;
  if (!previousUsage) return nextUsage;

  const promptTokens = nextUsage.prompt_tokens ?? previousUsage.prompt_tokens ?? null;
  const completionTokens = nextUsage.completion_tokens ?? previousUsage.completion_tokens ?? null;
  const totalTokens = promptTokens != null || completionTokens != null
    ? (promptTokens || 0) + (completionTokens || 0)
    : (nextUsage.total_tokens ?? previousUsage.total_tokens ?? null);

  return {
    ...previousUsage,
    ...nextUsage,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cost: nextUsage.cost ?? previousUsage.cost ?? null,
    cache_read_input_tokens: nextUsage.cache_read_input_tokens ?? previousUsage.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: nextUsage.cache_creation_input_tokens ?? previousUsage.cache_creation_input_tokens ?? null,
    cache_creation: nextUsage.cache_creation ?? previousUsage.cache_creation ?? null,
  };
}
