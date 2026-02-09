const API_PROXY_URL = '/api/chat';
const MODELS_PROXY_URL = '/api/models';
const MODELS_SEARCH_URL = '/api/models/search';
const PROVIDERS_PROXY_URL = '/api/providers';
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 90000;
const MIN_STREAM_STALL_TIMEOUT_MS = 15000;

function getStreamStallTimeoutMs() {
  const configured = Number(import.meta.env.VITE_STREAM_STALL_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_STREAM_STALL_TIMEOUT_MS;
  return Math.max(MIN_STREAM_STALL_TIMEOUT_MS, Math.floor(configured));
}

export class OpenRouterError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Extract usage info from an API response object.
 */
function extractUsage(obj) {
  const u = obj?.usage || obj;
  if (!u) return null;
  const toFiniteNumber = (value) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const promptTokens = toFiniteNumber(
    u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.promptTokenCount
  );
  const completionTokens = toFiniteNumber(
    u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.candidatesTokenCount ?? u.outputTokenCount
  );
  const totalTokens = toFiniteNumber(
    u.total_tokens ?? u.totalTokens ?? u.totalTokenCount
  ) ?? (
    promptTokens != null && completionTokens != null
      ? promptTokens + completionTokens
      : null
  );
  const cost = toFiniteNumber(u.cost ?? u.total_cost);
  const reasoningTokens = toFiniteNumber(u.completion_tokens_details?.reasoning_tokens);
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    reasoningTokens,
  };
  if (
    usage.promptTokens == null &&
    usage.completionTokens == null &&
    usage.totalTokens == null &&
    usage.cost == null &&
    usage.reasoningTokens == null
  ) {
    return null;
  }
  return usage;
}

/**
 * Extract reasoning text from reasoning_details array.
 */
function extractReasoningText(details) {
  if (!Array.isArray(details)) return '';
  return details
    .map(d => d.text || d.summary || '')
    .filter(Boolean)
    .join('\n');
}

function updateReasoningAccumulated(accumulated, incoming) {
  if (!incoming) return accumulated;
  if (!accumulated) return incoming;
  if (incoming.startsWith(accumulated)) return incoming;
  if (accumulated.startsWith(incoming)) return accumulated;

  const maxOverlap = Math.min(accumulated.length, incoming.length);
  for (let i = maxOverlap; i > 0; i -= 1) {
    if (accumulated.slice(-i) === incoming.slice(0, i)) {
      return accumulated + incoming.slice(i);
    }
  }
  return accumulated + incoming;
}

/**
 * Stream a chat completion from OpenRouter.
 * Calls onChunk with each text delta as it arrives.
 * Returns { content, reasoning, usage, durationMs }.
 */
export async function streamChat({ model, messages, apiKey, onChunk, onReasoning, signal, nativeWebSearch = false }) {
  const startTime = performance.now();
  const stallTimeoutMs = getStreamStallTimeoutMs();
  const requestAbortController = new AbortController();
  const forwardAbort = () => requestAbortController.abort();
  if (signal?.aborted) {
    requestAbortController.abort();
  } else if (signal) {
    signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    let responseTimeoutId = null;
    let response;
    try {
      response = await Promise.race([
        fetch(API_PROXY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            clientApiKey: apiKey || undefined,
            nativeWebSearch: nativeWebSearch || undefined,
          }),
          signal: requestAbortController.signal,
        }),
        new Promise((_, reject) => {
          responseTimeoutId = setTimeout(() => {
            requestAbortController.abort();
            reject(
              new OpenRouterError(
                `Stream stalled for ${Math.round(stallTimeoutMs / 1000)}s without receiving data. Request cancelled. You can retry this response.`,
                504,
                'stream_stalled'
              )
            );
          }, stallTimeoutMs);
        }),
      ]);
    } finally {
      if (responseTimeoutId != null) clearTimeout(responseTimeoutId);
    }

    if (!response.ok) {
      let errorMessage = `API error: ${response.status}`;
      let errorCode = null;
      try {
        const errorBody = await response.json();
        errorMessage = errorBody.error?.message || errorBody.error || errorMessage;
        errorCode = errorBody.error?.code || null;
      } catch {
        // ignore parse failures
      }

      if (response.status === 401) {
        throw new OpenRouterError('Unauthorized. Check server API key configuration.', 401, 'invalid_key');
      }
      if (response.status === 429) {
        throw new OpenRouterError('Rate limited. Please wait a moment and try again.', 429, 'rate_limit');
      }
      if (response.status === 402) {
        throw new OpenRouterError('Insufficient credits. Please add credits to your provider account.', 402, 'insufficient_credits');
      }
      throw new OpenRouterError(errorMessage, response.status, errorCode);
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      throw new OpenRouterError('Streaming response body was unavailable.', 500, 'stream_unavailable');
    }
    const decoder = new TextDecoder();
    let accumulated = '';
    let accumulatedReasoning = '';
    let buffer = '';
    let usage = null;
    let streamError = null;

    const readWithTimeout = async () => {
      let timeoutId = null;
      try {
        return await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(
                new OpenRouterError(
                  `Stream stalled for ${Math.round(stallTimeoutMs / 1000)}s without receiving data. Request cancelled. You can retry this response.`,
                  504,
                  'stream_stalled'
                )
              );
            }, stallTimeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId != null) clearTimeout(timeoutId);
      }
    };

    while (true) {
      let chunk;
      try {
        chunk = await readWithTimeout();
      } catch (err) {
        if (err?.code === 'stream_stalled') {
          requestAbortController.abort();
          try {
            await reader.cancel();
          } catch {
            // ignore cancellation cleanup failures
          }
        }
        throw err;
      }

      const { done, value } = chunk;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content' && parsed.delta) {
            accumulated += parsed.delta;
            onChunk?.(parsed.delta, accumulated);
          }
          if (parsed.type === 'reasoning' && parsed.delta) {
            accumulatedReasoning = updateReasoningAccumulated(accumulatedReasoning, parsed.delta);
            onReasoning?.(accumulatedReasoning);
          }
          if (parsed.type === 'done') {
            usage = extractUsage(parsed.usage || {});
          }
          if (parsed.type === 'error') {
            streamError = parsed.message || 'Stream error';
            await reader.cancel();
            break;
          }
        } catch {
          // skip malformed JSON chunks
        }
      }
      if (streamError) break;
    }

    if (streamError) {
      throw new OpenRouterError(streamError, 500, 'stream_error');
    }

    const durationMs = Math.round(performance.now() - startTime);
    return { content: accumulated, reasoning: accumulatedReasoning || null, usage, durationMs };
  } finally {
    if (signal) {
      signal.removeEventListener('abort', forwardAbort);
    }
  }
}

/**
 * Non-streaming chat completion from OpenRouter.
 * Used for convergence checks and other quick evaluations.
 * Returns { content, usage, durationMs }.
 */
export async function chatCompletion({ model, messages, apiKey, signal, nativeWebSearch = false }) {
  const startTime = performance.now();

  const response = await fetch(API_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      clientApiKey: apiKey || undefined,
      nativeWebSearch: nativeWebSearch || undefined,
    }),
    signal,
  });

  if (!response.ok) {
    let errorMessage = `API error: ${response.status}`;
    let errorCode = null;
    try {
      const errorBody = await response.json();
      errorMessage = errorBody.error?.message || errorBody.error || errorMessage;
      errorCode = errorBody.error?.code || null;
    } catch {
      // ignore parse failures
    }

    if (response.status === 401) {
      throw new OpenRouterError('Unauthorized. Check server API key configuration.', 401, 'invalid_key');
    }
    if (response.status === 429) {
      throw new OpenRouterError('Rate limited. Please wait a moment and try again.', 429, 'rate_limit');
    }
    if (response.status === 402) {
      throw new OpenRouterError('Insufficient credits. Please add credits to your provider account.', 402, 'insufficient_credits');
    }
    throw new OpenRouterError(errorMessage, response.status, errorCode);
  }

  const data = await response.json();
  const durationMs = Math.round(performance.now() - startTime);
  const content = data.content || '';
  const reasoning = data.reasoning || null;
  const usage = extractUsage(data.usage || {});
  return { content, reasoning, usage, durationMs };
}

/**
 * Fetch available models from OpenRouter.
 */
export async function fetchModels(apiKey) {
  const headers = {};
  if (apiKey) {
    headers['x-openrouter-api-key'] = apiKey;
  }
  const response = await fetch(MODELS_PROXY_URL, { headers });

  if (!response.ok) {
    throw new OpenRouterError('Failed to fetch models', response.status);
  }

  const data = await response.json();
  return data.data || [];
}

export async function searchModels({ query = '', provider = '', limit = 200, offset = 0, apiKey } = {}) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (provider) params.set('provider', provider);
  if (limit != null) params.set('limit', String(limit));
  if (offset != null) params.set('offset', String(offset));
  const headers = {};
  if (apiKey) {
    headers['x-openrouter-api-key'] = apiKey;
  }
  const response = await fetch(`${MODELS_SEARCH_URL}?${params.toString()}`, { headers });
  if (!response.ok) {
    throw new OpenRouterError('Failed to search models', response.status);
  }
  return response.json();
}

export async function fetchProviders() {
  const response = await fetch(PROVIDERS_PROXY_URL);
  if (!response.ok) {
    throw new OpenRouterError('Failed to fetch providers', response.status);
  }
  return response.json();
}

export const DEFAULT_DEBATE_MODELS = [
  'anthropic/claude-3.7-sonnet',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
];

export const DEFAULT_SYNTHESIZER_MODEL = 'anthropic/claude-3.7-sonnet';

export const DEFAULT_CONVERGENCE_MODEL = 'google/gemini-2.0-flash-001';

export const DEFAULT_MAX_DEBATE_ROUNDS = 3;

export const DEFAULT_WEB_SEARCH_MODEL = 'perplexity/sonar';

export const MODEL_COLORS = {
  'anthropic': 'var(--accent-purple)',
  'google': 'var(--accent-blue)',
  'meta-llama': 'var(--accent-orange)',
  'openai': 'var(--accent-green)',
  'mistralai': 'var(--accent-cyan)',
  'gemini': 'var(--accent-blue)',
  'default': 'var(--accent-pink)',
};

function parseModelId(modelId) {
  if (!modelId) return { provider: '', name: '' };
  if (modelId.includes(':')) {
    const [prefix, rest] = modelId.split(':');
    return { provider: prefix, name: rest };
  }
  const parts = modelId.split('/');
  return { provider: parts[0], name: parts.slice(1).join('/') };
}

export function getModelColor(modelId) {
  const { provider } = parseModelId(modelId);
  return MODEL_COLORS[provider] || MODEL_COLORS.default;
}

export function getModelDisplayName(modelId) {
  const { name } = parseModelId(modelId);
  return name || modelId;
}

export function getProviderName(modelId) {
  const { provider } = parseModelId(modelId);
  const names = {
    'anthropic': 'Anthropic',
    'gemini': 'Google',
    'google': 'Google',
    'meta-llama': 'Meta',
    'openai': 'OpenAI',
    'mistralai': 'Mistral',
    'openrouter': 'OpenRouter',
  };
  return names[provider] || provider;
}
