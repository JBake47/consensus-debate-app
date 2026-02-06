import express from 'express';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'node:crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_REMOTE_API = process.env.ALLOW_REMOTE_API === 'true';
const SERVER_AUTH_TOKEN = process.env.SERVER_AUTH_TOKEN || '';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const OPENROUTER_WEB_PLUGIN_ID = process.env.OPENROUTER_WEB_PLUGIN_ID || 'web';
const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = process.env.ANTHROPIC_WEB_SEARCH_TOOL_TYPE || 'web_search_20250305';
const ANTHROPIC_WEB_SEARCH_BETA = process.env.ANTHROPIC_WEB_SEARCH_BETA || 'web-search-2025-03-05';
const OPENAI_WEB_SEARCH_MODE = process.env.OPENAI_WEB_SEARCH_MODE || 'web_search_options';

if (TRUST_PROXY) {
  app.set('trust proxy', true);
}

app.use(express.json({ limit: '60mb' }));

function normalizeIp(value) {
  if (!value) return '';
  let ip = String(value).trim();
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }
  if (ip.includes(':') && ip.includes('.') && ip.lastIndexOf(':') > ip.lastIndexOf('.')) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  return ip;
}

function isLoopbackIp(ip) {
  const normalized = normalizeIp(ip);
  return normalized === '127.0.0.1' || normalized === '::1';
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function hasValidServerToken(req) {
  if (!SERVER_AUTH_TOKEN) return false;
  const token = req.get('x-server-auth-token');
  return constantTimeEquals(token, SERVER_AUTH_TOKEN);
}

app.use('/api', (req, res, next) => {
  if (ALLOW_REMOTE_API) {
    next();
    return;
  }

  const directIp = req.socket?.remoteAddress || '';
  const clientIp = normalizeIp(req.ip || directIp);
  const localRequest = isLoopbackIp(clientIp) || isLoopbackIp(directIp);

  if (localRequest || hasValidServerToken(req)) {
    next();
    return;
  }

  res.status(403).json({
    error: 'Remote API access denied. Use localhost, set SERVER_AUTH_TOKEN, or set ALLOW_REMOTE_API=true.',
  });
});

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseModelTarget(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return { provider: 'openrouter', model: modelId };
  }

  if (modelId.startsWith('openrouter/')) {
    return { provider: 'openrouter', model: modelId.slice('openrouter/'.length) };
  }

  const colonIdx = modelId.indexOf(':');
  if (colonIdx > 0) {
    const prefix = modelId.slice(0, colonIdx).toLowerCase();
    const rest = modelId.slice(colonIdx + 1);
    if (prefix === 'openai') return { provider: 'openai', model: rest };
    if (prefix === 'anthropic') return { provider: 'anthropic', model: rest };
    if (prefix === 'gemini' || prefix === 'google') return { provider: 'gemini', model: rest };
    if (prefix === 'openrouter') return { provider: 'openrouter', model: rest };
  }

  return { provider: 'openrouter', model: modelId };
}

function splitSystemMessages(messages) {
  const systemParts = [];
  const filtered = [];
  for (const message of messages || []) {
    if (message.role === 'system') {
      if (typeof message.content === 'string') {
        systemParts.push(message.content);
      }
    } else {
      filtered.push(message);
    }
  }
  return { system: systemParts.join('\n\n'), messages: filtered };
}

function normalizeParts(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function parseDataUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function buildAnthropicMessages(messages) {
  return (messages || []).map((message) => {
    const parts = normalizeParts(message.content).map((part) => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text || '' };
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        const parsed = parseDataUrl(part.image_url.url);
        if (parsed) {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mimeType,
              data: parsed.data,
            },
          };
        }
      }
      return null;
    }).filter(Boolean);

    return { role: message.role, content: parts };
  });
}

function buildGeminiContents(messages) {
  return (messages || []).map((message) => {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = normalizeParts(message.content).map((part) => {
      if (part.type === 'text') {
        return { text: part.text || '' };
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        const parsed = parseDataUrl(part.image_url.url);
        if (parsed) {
          return { inline_data: { mime_type: parsed.mimeType, data: parsed.data } };
        }
      }
      return null;
    }).filter(Boolean);
    return { role, parts };
  });
}

async function readSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) {
        eventName = trimmed.slice(6).trim();
        continue;
      }
      if (trimmed.startsWith('data:')) {
        dataLines.push(trimmed.slice(5).trim());
        continue;
      }
      if (trimmed === '') {
        if (dataLines.length > 0) {
          const data = dataLines.join('\n');
          await onEvent(eventName, data);
          dataLines = [];
          eventName = 'message';
        }
      }
    }
  }
}

function extractReasoningText(details) {
  if (!Array.isArray(details)) return '';
  return details
    .map(d => d.text || d.summary || '')
    .filter(Boolean)
    .join('\n');
}

async function handleOpenRouter({ model, messages, stream, res, signal, clientApiKey, nativeWebSearch = false }) {
  const apiKey = clientApiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OpenRouter API key');
  }

  const body = {
    model,
    messages,
    stream,
    include_reasoning: true,
  };
  if (nativeWebSearch) {
    body.plugins = [{ id: OPENROUTER_WEB_PLUGIN_ID }];
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost',
      'X-Title': process.env.OPENROUTER_TITLE || 'Consensus',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `OpenRouter error: ${response.status}`);
  }

  if (!stream) {
    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      reasoning: data.choices?.[0]?.message?.reasoning || null,
      usage: data.usage || null,
    };
  }

  let usage = null;
  await readSseStream(response, async (_event, data) => {
    if (data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) {
      sendSse(res, { type: 'content', delta: delta.content });
    }
    if (delta?.reasoning) {
      sendSse(res, { type: 'reasoning', delta: delta.reasoning });
    }
    if (delta?.reasoning_details) {
      const text = extractReasoningText(delta.reasoning_details);
      if (text) sendSse(res, { type: 'reasoning', delta: text });
    }
    if (parsed.usage) {
      usage = parsed.usage;
    }
  });

  sendSse(res, { type: 'done', usage });
  return null;
}

async function handleAnthropic({ model, messages, stream, res, signal, nativeWebSearch = false }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing Anthropic API key');
  }

  const { system, messages: filtered } = splitSystemMessages(messages);
  const body = {
    model,
    max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 64000),
    messages: buildAnthropicMessages(filtered),
    stream,
  };
  if (system) body.system = system;
  if (nativeWebSearch) {
    body.tools = [{ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: 'web_search' }];
    body.tool_choice = { type: 'auto' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
  };
  if (nativeWebSearch) {
    headers['anthropic-beta'] = ANTHROPIC_WEB_SEARCH_BETA;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(bodyText || `Anthropic error: ${response.status}`);
  }

  if (!stream) {
    const data = await response.json();
    const contentBlocks = Array.isArray(data.content) ? data.content : [];
    const content = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const reasoning = contentBlocks.filter(b => b.type === 'thinking').map(b => b.text).join('') || null;
    const usage = data.usage
      ? {
        prompt_tokens: data.usage.input_tokens ?? null,
        completion_tokens: data.usage.output_tokens ?? null,
        total_tokens: data.usage.input_tokens && data.usage.output_tokens
          ? data.usage.input_tokens + data.usage.output_tokens
          : null,
      }
      : null;
    return { content, reasoning, usage };
  }

  const blockTypes = new Map();
  let usage = null;

  await readSseStream(response, async (event, data) => {
    if (!data || data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (event === 'message_start') {
      if (parsed.message?.usage) {
        const u = parsed.message.usage;
        usage = {
          prompt_tokens: u.input_tokens ?? null,
          completion_tokens: u.output_tokens ?? null,
          total_tokens: u.input_tokens && u.output_tokens ? u.input_tokens + u.output_tokens : null,
        };
      }
    }

    if (event === 'content_block_start') {
      const index = parsed.index;
      const type = parsed.content_block?.type;
      if (typeof index === 'number' && type) {
        blockTypes.set(index, type);
      }
    }

    if (event === 'content_block_delta') {
      const index = parsed.index;
      const blockType = blockTypes.get(index);
      const delta = parsed.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        if (blockType === 'thinking') {
          sendSse(res, { type: 'reasoning', delta: delta.text });
        } else {
          sendSse(res, { type: 'content', delta: delta.text });
        }
      }
      if (delta?.type === 'thinking_delta' && delta.thinking) {
        sendSse(res, { type: 'reasoning', delta: delta.thinking });
      }
    }

    if (event === 'message_delta') {
      if (parsed.usage) {
        const u = parsed.usage;
        usage = {
          prompt_tokens: u.input_tokens ?? null,
          completion_tokens: u.output_tokens ?? null,
          total_tokens: u.input_tokens && u.output_tokens ? u.input_tokens + u.output_tokens : null,
        };
      }
    }
  });

  sendSse(res, { type: 'done', usage });
  return null;
}

async function handleOpenAI({ model, messages, stream, res, signal, nativeWebSearch = false }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OpenAI API key');
  }

  const body = {
    model,
    messages,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
  };
  if (nativeWebSearch) {
    if (OPENAI_WEB_SEARCH_MODE === 'tools') {
      body.tools = [{ type: 'web_search' }];
      body.tool_choice = 'auto';
    } else {
      body.web_search_options = {};
    }
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(bodyText || `OpenAI error: ${response.status}`);
  }

  if (!stream) {
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content || '',
      reasoning: message?.reasoning || message?.reasoning_content || null,
      usage: data.usage || null,
    };
  }

  let usage = null;
  await readSseStream(response, async (_event, data) => {
    if (data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) {
      sendSse(res, { type: 'content', delta: delta.content });
    }
    if (delta?.reasoning) {
      sendSse(res, { type: 'reasoning', delta: delta.reasoning });
    }
    if (delta?.reasoning_content) {
      sendSse(res, { type: 'reasoning', delta: delta.reasoning_content });
    }
    if (parsed.usage) {
      usage = parsed.usage;
    }
  });

  sendSse(res, { type: 'done', usage });
  return null;
}

async function handleGemini({ model, messages, stream, res, signal, nativeWebSearch = false }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing Gemini API key');
  }

  const { system, messages: filtered } = splitSystemMessages(messages);
  const contents = buildGeminiContents(filtered);
  const body = {
    contents,
  };
  if (system) {
    body.system_instruction = { parts: [{ text: system }] };
  }
  if (nativeWebSearch) {
    body.tools = [{ google_search: {} }];
  }

  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
  const endpoint = stream ? `${baseUrl}:streamGenerateContent?key=${apiKey}` : `${baseUrl}:generateContent?key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(bodyText || `Gemini error: ${response.status}`);
  }

  if (!stream) {
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    return { content: text, reasoning: null, usage: data.usageMetadata || null };
  }

  let usage = null;
  await readSseStream(response, async (_event, data) => {
    if (!data || data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const text = parsed.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
    if (text) {
      sendSse(res, { type: 'content', delta: text });
    }
    if (parsed.usageMetadata) {
      usage = parsed.usageMetadata;
    }
  });

  sendSse(res, { type: 'done', usage });
  return null;
}

app.post('/api/chat', async (req, res) => {
  const { model, messages, stream, clientApiKey, nativeWebSearch } = req.body || {};
  const { provider, model: providerModel } = parseModelTarget(model);
  const useNativeWebSearch = nativeWebSearch === true;
  const abortController = new AbortController();

  const abortIfOpen = () => {
    if (!abortController.signal.aborted) abortController.abort();
  };

  // Abort upstream only if the client disconnects mid-request.
  req.on('aborted', abortIfOpen);
  res.on('close', () => {
    if (!res.writableEnded) abortIfOpen();
  });

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
    }

    let result = null;
    if (provider === 'openrouter') {
      result = await handleOpenRouter({
        model: providerModel,
        messages,
        stream,
        res,
        signal: abortController.signal,
        clientApiKey,
        nativeWebSearch: useNativeWebSearch,
      });
    } else if (provider === 'anthropic') {
      result = await handleAnthropic({
        model: providerModel,
        messages,
        stream,
        res,
        signal: abortController.signal,
        nativeWebSearch: useNativeWebSearch,
      });
    } else if (provider === 'openai') {
      result = await handleOpenAI({
        model: providerModel,
        messages,
        stream,
        res,
        signal: abortController.signal,
        nativeWebSearch: useNativeWebSearch,
      });
    } else if (provider === 'gemini') {
      result = await handleGemini({
        model: providerModel,
        messages,
        stream,
        res,
        signal: abortController.signal,
        nativeWebSearch: useNativeWebSearch,
      });
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    if (!stream) {
      res.json(result);
    } else {
      res.end();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('API /api/chat error', {
      provider,
      model: providerModel,
      stream: Boolean(stream),
      nativeWebSearch: useNativeWebSearch,
      message: err?.message || String(err),
    });
    if (stream) {
      sendSse(res, { type: 'error', message: err.message || 'Request failed' });
      res.end();
      return;
    }
    res.status(500).json({
      error: err.message || 'Request failed',
      provider,
      model: providerModel,
    });
  }
});

app.get('/api/models', async (_req, res) => {
  const apiKey = _req.get('x-openrouter-api-key') || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.json({ data: [] });
    return;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      const bodyText = await response.text();
      res.status(500).json({ error: bodyText || 'Failed to fetch models' });
      return;
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch models' });
  }
});

app.get('/api/models/search', async (req, res) => {
  const apiKey = req.get('x-openrouter-api-key') || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.json({ data: [] });
    return;
  }

  const query = String(req.query.q || '').toLowerCase().trim();
  const provider = String(req.query.provider || '').toLowerCase().trim();
  const parsedLimit = Number(req.query.limit);
  const parsedOffset = Number(req.query.offset);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(Math.floor(parsedLimit), 0), 500)
    : 200;
  const offset = Number.isFinite(parsedOffset)
    ? Math.max(Math.floor(parsedOffset), 0)
    : 0;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      const bodyText = await response.text();
      res.status(500).json({ error: bodyText || 'Failed to fetch models' });
      return;
    }
    const data = await response.json();
    let models = data.data || [];
    if (provider) {
      models = models.filter(m => {
        const id = (m.id || '').toLowerCase();
        return id.startsWith(`${provider}/`);
      });
    }
    if (query) {
      models = models.filter(m => {
        const id = (m.id || '').toLowerCase();
        const name = (m.name || '').toLowerCase();
        const description = (m.description || '').toLowerCase();
        return id.includes(query) || name.includes(query) || description.includes(query);
      });
    }
    const total = models.length;
    const sliced = models.slice(offset, offset + limit);
    res.json({ data: sliced, total });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch models' });
  }
});

app.get('/api/providers', (_req, res) => {
  res.json({
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    providers: {
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
    },
  });
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`API server listening on http://${HOST}:${PORT}`);
});
