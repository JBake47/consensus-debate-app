const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
  const u = obj?.usage;
  if (!u) return null;
  return {
    promptTokens: u.prompt_tokens ?? null,
    completionTokens: u.completion_tokens ?? null,
    totalTokens: u.total_tokens ?? null,
    cost: u.cost ?? null,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
  };
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
export async function streamChat({ model, messages, apiKey, onChunk, onReasoning, signal }) {
  const startTime = performance.now();

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'OpenRouter Debate App',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      include_reasoning: true,
    }),
    signal,
  });

  if (!response.ok) {
    let errorMessage = `API error: ${response.status}`;
    let errorCode = null;
    try {
      const errorBody = await response.json();
      errorMessage = errorBody.error?.message || errorMessage;
      errorCode = errorBody.error?.code || null;
    } catch {
      // ignore parse failures
    }

    if (response.status === 401) {
      throw new OpenRouterError('Invalid API key. Please check your key in Settings.', 401, 'invalid_key');
    }
    if (response.status === 429) {
      throw new OpenRouterError('Rate limited. Please wait a moment and try again.', 429, 'rate_limit');
    }
    if (response.status === 402) {
      throw new OpenRouterError('Insufficient credits. Please add credits to your OpenRouter account.', 402, 'insufficient_credits');
    }
    throw new OpenRouterError(errorMessage, response.status, errorCode);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let accumulatedReasoning = '';
  let buffer = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
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
        const delta = parsed.choices?.[0]?.delta;

        // Content delta
        if (delta?.content) {
          accumulated += delta.content;
          onChunk?.(delta.content, accumulated);
        }

        // Reasoning delta (streamed reasoning text)
        if (delta?.reasoning) {
          accumulatedReasoning = updateReasoningAccumulated(accumulatedReasoning, delta.reasoning);
          onReasoning?.(accumulatedReasoning);
        }

        // Reasoning details (structured reasoning blocks)
        if (delta?.reasoning_details) {
          const text = extractReasoningText(delta.reasoning_details);
          if (text) {
            accumulatedReasoning = updateReasoningAccumulated(accumulatedReasoning, text);
            onReasoning?.(accumulatedReasoning);
          }
        }

        if (parsed.usage) {
          usage = extractUsage(parsed);
        }
      } catch {
        // skip malformed JSON chunks
      }
    }
  }

  const durationMs = Math.round(performance.now() - startTime);
  return { content: accumulated, reasoning: accumulatedReasoning || null, usage, durationMs };
}

/**
 * Non-streaming chat completion from OpenRouter.
 * Used for convergence checks and other quick evaluations.
 * Returns { content, usage, durationMs }.
 */
export async function chatCompletion({ model, messages, apiKey, signal }) {
  const startTime = performance.now();

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'OpenRouter Debate App',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    let errorMessage = `API error: ${response.status}`;
    let errorCode = null;
    try {
      const errorBody = await response.json();
      errorMessage = errorBody.error?.message || errorMessage;
      errorCode = errorBody.error?.code || null;
    } catch {
      // ignore parse failures
    }

    if (response.status === 401) {
      throw new OpenRouterError('Invalid API key. Please check your key in Settings.', 401, 'invalid_key');
    }
    if (response.status === 429) {
      throw new OpenRouterError('Rate limited. Please wait a moment and try again.', 429, 'rate_limit');
    }
    if (response.status === 402) {
      throw new OpenRouterError('Insufficient credits. Please add credits to your OpenRouter account.', 402, 'insufficient_credits');
    }
    throw new OpenRouterError(errorMessage, response.status, errorCode);
  }

  const data = await response.json();
  const durationMs = Math.round(performance.now() - startTime);
  const message = data.choices?.[0]?.message;
  const content = message?.content || '';
  const usage = extractUsage(data);
  return { content, usage, durationMs };
}

/**
 * Fetch available models from OpenRouter.
 */
export async function fetchModels(apiKey) {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new OpenRouterError('Failed to fetch models', response.status);
  }

  const data = await response.json();
  return data.data || [];
}

export const DEFAULT_DEBATE_MODELS = [
  'anthropic/claude-3-opus',
  'google/gemini-2.0-flash-exp',
  'meta-llama/llama-3-70b-instruct',
];

export const DEFAULT_SYNTHESIZER_MODEL = 'anthropic/claude-3.5-sonnet';

export const DEFAULT_CONVERGENCE_MODEL = 'google/gemini-2.0-flash-exp';

export const DEFAULT_MAX_DEBATE_ROUNDS = 3;

export const DEFAULT_WEB_SEARCH_MODEL = 'perplexity/sonar';

export const MODEL_COLORS = {
  'anthropic': 'var(--accent-purple)',
  'google': 'var(--accent-blue)',
  'meta-llama': 'var(--accent-orange)',
  'openai': 'var(--accent-green)',
  'mistralai': 'var(--accent-cyan)',
  'default': 'var(--accent-pink)',
};

export function getModelColor(modelId) {
  const provider = modelId.split('/')[0];
  return MODEL_COLORS[provider] || MODEL_COLORS.default;
}

export function getModelDisplayName(modelId) {
  const parts = modelId.split('/');
  return parts.length > 1 ? parts[1] : modelId;
}

export function getProviderName(modelId) {
  const provider = modelId.split('/')[0];
  const names = {
    'anthropic': 'Anthropic',
    'google': 'Google',
    'meta-llama': 'Meta',
    'openai': 'OpenAI',
    'mistralai': 'Mistral',
  };
  return names[provider] || provider;
}
