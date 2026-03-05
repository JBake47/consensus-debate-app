import express from 'express';
import dotenv from 'dotenv';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import PDFDocument from 'pdfkit';
import {
  Document as DocxDocument,
  Packer as DocxPacker,
  Paragraph,
  HeadingLevel,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

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
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_DOC_MODEL = process.env.OPENAI_DOC_MODEL || 'gpt-4.1-mini';
const ANTHROPIC_DOC_MODEL = process.env.ANTHROPIC_DOC_MODEL || 'claude-sonnet-4-5';
const GEMINI_DOC_MODEL = process.env.GEMINI_DOC_MODEL || 'gemini-2.5-flash';
const OPENROUTER_DOC_MODEL = process.env.OPENROUTER_DOC_MODEL || 'google/gemini-2.0-flash-001';
const GEMINI_YOUTUBE_MODEL = process.env.GEMINI_YOUTUBE_MODEL || 'gemini-2.5-flash';

const YOUTUBE_URL_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s]+|youtube\.com\/shorts\/[^\s]+|youtu\.be\/[^\s]+)/gi;
const IMAGE_INTENT_REGEX = /\b(generate|create|make|draw|design|render)\b[\s\S]{0,80}\b(image|picture|photo|illustration|logo|cover art|artwork|icon)\b/i;
const DOCX_INTENT_REGEX = /\b(docx|word document|ms word|word file)\b/i;
const PDF_INTENT_REGEX = /\b(pdf|portable document)\b/i;
const XLSX_INTENT_REGEX = /\b(xlsx|excel|spreadsheet|workbook)\b/i;
const GENERATE_INTENT_REGEX = /\b(generate|create|make|produce|export|output|save|convert)\b/i;
const DOC_GENERATION_MAX_BYTES = Number(process.env.DOC_GENERATION_MAX_BYTES || 12 * 1024 * 1024);
const FILE_TEXT_EXTRACTION_MAX_BYTES = Number(process.env.FILE_TEXT_EXTRACTION_MAX_BYTES || 12 * 1024 * 1024);
const ARTIFACT_TTL_MS = Number(process.env.ARTIFACT_TTL_MS || 24 * 60 * 60 * 1000);
const ARTIFACT_STORE_DIR = process.env.ARTIFACT_STORE_DIR
  ? path.resolve(process.env.ARTIFACT_STORE_DIR)
  : path.join(process.cwd(), 'server', '.artifacts');
const JOB_TTL_MS = Number(process.env.MULTIMODAL_JOB_TTL_MS || 60 * 60 * 1000);
const MAX_JOB_POLL_MS = Number(process.env.MULTIMODAL_MAX_JOB_POLL_MS || 45 * 1000);
const MULTIMODAL_MAX_ATTACHMENTS = Number(process.env.MULTIMODAL_MAX_ATTACHMENTS || 16);

if (TRUST_PROXY) {
  app.set('trust proxy', true);
}

app.use(express.json({ limit: '60mb' }));

const artifactStore = new Map();
const multimodalJobs = new Map();
const multimodalJobFingerprints = new Map();
const multimodalQueue = [];
let multimodalWorkerRunning = false;
const providerHealth = {
  openrouter: { attempts: 0, successes: 0, failures: 0, totalMs: 0, lastError: '', updatedAt: 0 },
  anthropic: { attempts: 0, successes: 0, failures: 0, totalMs: 0, lastError: '', updatedAt: 0 },
  openai: { attempts: 0, successes: 0, failures: 0, totalMs: 0, lastError: '', updatedAt: 0 },
  gemini: { attempts: 0, successes: 0, failures: 0, totalMs: 0, lastError: '', updatedAt: 0 },
};

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

function getForwardedIpChain(req) {
  const forwarded = String(req.get('x-forwarded-for') || '');
  const forwardedIps = forwarded
    .split(',')
    .map((value) => normalizeIp(value))
    .filter(Boolean);
  const directIp = normalizeIp(req.socket?.remoteAddress || '');
  if (directIp) {
    forwardedIps.push(directIp);
  }
  return forwardedIps;
}

function getTrustedClientIp(req) {
  const directIp = normalizeIp(req.socket?.remoteAddress || '');
  if (!TRUST_PROXY) {
    return directIp;
  }

  const chain = getForwardedIpChain(req);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (!isLoopbackIp(candidate)) {
      return candidate;
    }
  }
  return chain[0] || directIp;
}

function createRequestAbortContext(req, res) {
  const controller = new AbortController();
  let cleanedUp = false;

  const abortIfOpen = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    req.off?.('aborted', onAbort);
    res.off?.('close', onClose);
    res.off?.('finish', cleanup);
  };

  const onAbort = () => {
    abortIfOpen();
    cleanup();
  };

  const onClose = () => {
    if (!res.writableEnded) {
      abortIfOpen();
    }
    cleanup();
  };

  req.on('aborted', onAbort);
  res.on('close', onClose);
  res.on('finish', cleanup);

  return {
    signal: controller.signal,
    abort: abortIfOpen,
    cleanup,
  };
}

function decodeRequestHeaderValue(value) {
  const raw = String(value || '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sanitizeUploadedFileName(value) {
  return decodeRequestHeaderValue(value)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .trim();
}

function getExtractableFileCategory(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (['.xlsx', '.xls', '.xlsm'].includes(ext)) return 'excel';
  if (ext === '.docx') return 'word';
  return '';
}

function stringifySpreadsheetCell(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value.richText) {
      return value.richText.map((part) => part.text || '').join('');
    }
    if (value.text) return String(value.text);
    if (value.result != null) return String(value.result);
    if (value.formula) return String(value.formula);
    if (value.hyperlink) return value.text || value.hyperlink;
    if (value instanceof Date) return value.toISOString();
    if (value.error) return String(value.error);
  }
  return String(value);
}

async function extractExcelTextFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheets = [];
  workbook.eachSheet((worksheet) => {
    const rows = [];
    worksheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((value) => stringifySpreadsheetCell(value)).join(','));
    });
    sheets.push(`--- Sheet: ${worksheet.name} ---\n${rows.join('\n')}`);
  });
  return sheets.join('\n\n');
}

async function extractWordTextFromBuffer(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || '');
}

app.use('/api', (req, res, next) => {
  if (ALLOW_REMOTE_API) {
    next();
    return;
  }

  const clientIp = getTrustedClientIp(req);
  const localRequest = isLoopbackIp(clientIp);

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

app.post('/api/files/extract-text', express.raw({ type: 'application/octet-stream', limit: FILE_TEXT_EXTRACTION_MAX_BYTES }), async (req, res) => {
  const fileName = sanitizeUploadedFileName(req.get('x-file-name'));
  const category = getExtractableFileCategory(fileName);
  const body = req.body;

  if (!fileName || !category) {
    res.status(400).json({ error: 'Unsupported file type for text extraction.' });
    return;
  }

  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: 'File body is required.' });
    return;
  }

  try {
    const content = category === 'excel'
      ? await extractExcelTextFromBuffer(body)
      : await extractWordTextFromBuffer(body);
    res.json({ content, category });
  } catch (error) {
    res.status(422).json({
      error: `Failed to extract text from ${category} file.`,
      details: process.env.NODE_ENV === 'development' ? String(error?.message || error) : undefined,
    });
  }
});

async function ensureArtifactStoreDir() {
  await fs.mkdir(ARTIFACT_STORE_DIR, { recursive: true });
}

function nowMs() {
  return Date.now();
}

function createId(prefix = '') {
  const seed = randomBytes(10).toString('hex');
  return prefix ? `${prefix}_${seed}` : seed;
}

function sortJsonForHash(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonForHash(entry));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        const next = sortJsonForHash(value[key]);
        if (next !== undefined) {
          acc[key] = next;
        }
        return acc;
      }, {});
  }
  return value;
}

function buildMultimodalJobFingerprint(payload) {
  const normalized = JSON.stringify(sortJsonForHash(payload)) || 'null';
  return createHash('sha256').update(normalized).digest('hex');
}

function getFailureRate(providerId) {
  const stats = providerHealth[providerId];
  if (!stats || stats.attempts === 0) return 0;
  return Math.max(0, Math.min(1, stats.failures / stats.attempts));
}

function getAverageLatencyMs(providerId) {
  const stats = providerHealth[providerId];
  if (!stats || stats.successes === 0) return 0;
  return Math.round(stats.totalMs / stats.successes);
}

function recordProviderHealth(providerId, { success, durationMs, errorMessage = '' }) {
  const stats = providerHealth[providerId];
  if (!stats) return;
  stats.attempts += 1;
  stats.updatedAt = nowMs();
  if (success) {
    stats.successes += 1;
    stats.totalMs += Math.max(0, Number(durationMs) || 0);
    stats.lastError = '';
  } else {
    stats.failures += 1;
    stats.lastError = String(errorMessage || 'Unknown error');
  }
}

function cleanupExpiredArtifacts() {
  const now = nowMs();
  for (const [artifactId, artifact] of artifactStore.entries()) {
    if (!artifact || artifact.expiresAt > now) continue;
    artifactStore.delete(artifactId);
    fs.unlink(artifact.path).catch(() => {});
  }
}

function cleanupExpiredJobs() {
  const now = nowMs();
  for (const [jobId, job] of multimodalJobs.entries()) {
    if (!job || job.expiresAt > now) continue;
    if (job.fingerprint && multimodalJobFingerprints.get(job.fingerprint) === jobId) {
      multimodalJobFingerprints.delete(job.fingerprint);
    }
    multimodalJobs.delete(jobId);
  }
}

setInterval(() => {
  cleanupExpiredArtifacts();
  cleanupExpiredJobs();
}, 60 * 1000).unref?.();

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
      if (part.type === 'video_url' && part.video_url?.url) {
        return {
          file_data: {
            mime_type: 'video/*',
            file_uri: part.video_url.url,
          },
        };
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
    const usageInput = Number.isFinite(Number(data.usage?.input_tokens))
      ? Number(data.usage.input_tokens)
      : null;
    const usageOutput = Number.isFinite(Number(data.usage?.output_tokens))
      ? Number(data.usage.output_tokens)
      : null;
    const usageTotal = Number.isFinite(Number(data.usage?.total_tokens))
      ? Number(data.usage.total_tokens)
      : (
        usageInput != null && usageOutput != null ? usageInput + usageOutput : null
      );
    const usage = data.usage
      ? {
        prompt_tokens: usageInput,
        completion_tokens: usageOutput,
        total_tokens: usageTotal,
        cost: data.usage.cost ?? null,
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
        const promptTokens = Number.isFinite(Number(u.input_tokens)) ? Number(u.input_tokens) : null;
        const completionTokens = Number.isFinite(Number(u.output_tokens)) ? Number(u.output_tokens) : null;
        const totalTokens = Number.isFinite(Number(u.total_tokens))
          ? Number(u.total_tokens)
          : (
            promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
          );
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          cost: u.cost ?? null,
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
        const promptTokens = Number.isFinite(Number(u.input_tokens)) ? Number(u.input_tokens) : null;
        const completionTokens = Number.isFinite(Number(u.output_tokens)) ? Number(u.output_tokens) : null;
        const totalTokens = Number.isFinite(Number(u.total_tokens))
          ? Number(u.total_tokens)
          : (
            promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
          );
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          cost: u.cost ?? null,
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

function getServerProviderStatus(clientProvided = null) {
  const fallback = {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  };
  if (!clientProvided || typeof clientProvided !== 'object') return fallback;
  return {
    openrouter: Boolean(clientProvided.openrouter ?? fallback.openrouter),
    anthropic: Boolean(clientProvided.anthropic ?? fallback.anthropic),
    openai: Boolean(clientProvided.openai ?? fallback.openai),
    gemini: Boolean(clientProvided.gemini ?? fallback.gemini),
  };
}

function buildCapabilityRegistry(providerStatus) {
  const providers = {
    openrouter: {
      enabled: Boolean(providerStatus.openrouter),
      capabilities: {
        chat: true,
        imageInput: true,
        imageOutput: false,
        videoInput: true,
        youtubeAnalysis: true,
        docGeneration: true,
        ocr: true,
      },
      defaults: {
        documentModel: OPENROUTER_DOC_MODEL,
      },
    },
    anthropic: {
      enabled: Boolean(providerStatus.anthropic),
      capabilities: {
        chat: true,
        imageInput: true,
        imageOutput: false,
        videoInput: false,
        youtubeAnalysis: false,
        docGeneration: true,
        ocr: true,
      },
      defaults: {
        documentModel: ANTHROPIC_DOC_MODEL,
      },
    },
    openai: {
      enabled: Boolean(providerStatus.openai),
      capabilities: {
        chat: true,
        imageInput: true,
        imageOutput: true,
        videoInput: false,
        youtubeAnalysis: false,
        docGeneration: true,
        ocr: true,
      },
      defaults: {
        documentModel: OPENAI_DOC_MODEL,
        imageModel: OPENAI_IMAGE_MODEL,
      },
    },
    gemini: {
      enabled: Boolean(providerStatus.gemini),
      capabilities: {
        chat: true,
        imageInput: true,
        imageOutput: false,
        videoInput: true,
        youtubeAnalysis: true,
        docGeneration: true,
        ocr: true,
      },
      defaults: {
        documentModel: GEMINI_DOC_MODEL,
        youtubeModel: GEMINI_YOUTUBE_MODEL,
      },
    },
  };

  return {
    updatedAt: nowMs(),
    providers,
    routingVersion: '2026-03-05',
  };
}

function buildProviderHealthSnapshot() {
  const snapshot = {};
  for (const [providerId, stats] of Object.entries(providerHealth)) {
    snapshot[providerId] = {
      attempts: stats.attempts,
      successes: stats.successes,
      failures: stats.failures,
      failureRate: getFailureRate(providerId),
      avgLatencyMs: getAverageLatencyMs(providerId),
      lastError: stats.lastError,
      updatedAt: stats.updatedAt,
    };
  }
  return snapshot;
}

function getRoutingWeights(preferences = {}) {
  const priority = String(preferences.priority || 'balanced').toLowerCase();
  if (priority === 'quality') {
    return { quality: 0.45, latency: 0.1, cost: 0.1, reliability: 0.35 };
  }
  if (priority === 'latency' || priority === 'fast') {
    return { quality: 0.15, latency: 0.45, cost: 0.15, reliability: 0.25 };
  }
  if (priority === 'cost' || priority === 'cheap') {
    return { quality: 0.15, latency: 0.15, cost: 0.45, reliability: 0.25 };
  }
  return { quality: 0.3, latency: 0.22, cost: 0.2, reliability: 0.28 };
}

function getProviderProfile(providerId) {
  const profiles = {
    openai: { quality: 0.93, latency: 0.72, cost: 0.58 },
    anthropic: { quality: 0.91, latency: 0.64, cost: 0.55 },
    gemini: { quality: 0.86, latency: 0.83, cost: 0.81 },
    openrouter: { quality: 0.8, latency: 0.78, cost: 0.83 },
  };
  return profiles[providerId] || { quality: 0.6, latency: 0.5, cost: 0.5 };
}

function scoreRouteCandidate(candidate, preferences = {}) {
  const weights = getRoutingWeights(preferences);
  const profile = getProviderProfile(candidate.provider);
  const failureRate = getFailureRate(candidate.provider);
  const reliability = 1 - failureRate;
  let score = (
    (profile.quality * weights.quality) +
    (profile.latency * weights.latency) +
    (profile.cost * weights.cost) +
    (reliability * weights.reliability)
  );

  if (preferences.preferredProvider && preferences.preferredProvider === candidate.provider) {
    score += 0.08;
  }
  if (candidate.preferredModelMatch) {
    score += 0.06;
  }
  return Math.round(score * 1000) / 1000;
}

function buildToolCandidates({
  taskType,
  providerStatus,
  preferredModel = '',
  registry,
}) {
  const preferred = parseModelTarget(preferredModel);
  const candidates = [];
  const pushCandidate = (provider, model, requirements = {}) => {
    if (!providerStatus[provider]) return;
    const providerCaps = registry.providers[provider]?.capabilities || {};
    if (requirements.videoInput && !providerCaps.videoInput) return;
    if (requirements.youtubeAnalysis && !providerCaps.youtubeAnalysis) return;
    if (requirements.imageOutput && !providerCaps.imageOutput) return;
    if (requirements.ocr && !providerCaps.ocr) return;
    candidates.push({
      provider,
      model,
      preferredModelMatch: preferred.provider === provider,
    });
  };

  if (taskType === 'documents') {
    pushCandidate('openai', preferred.provider === 'openai' ? preferred.model || OPENAI_DOC_MODEL : OPENAI_DOC_MODEL);
    pushCandidate('anthropic', preferred.provider === 'anthropic' ? preferred.model || ANTHROPIC_DOC_MODEL : ANTHROPIC_DOC_MODEL);
    pushCandidate('gemini', preferred.provider === 'gemini' ? preferred.model || GEMINI_DOC_MODEL : GEMINI_DOC_MODEL);
    pushCandidate('openrouter', preferred.provider === 'openrouter' ? preferred.model || OPENROUTER_DOC_MODEL : OPENROUTER_DOC_MODEL);
  } else if (taskType === 'image') {
    pushCandidate('openai', OPENAI_IMAGE_MODEL, { imageOutput: true });
  } else if (taskType === 'youtube') {
    pushCandidate('gemini', GEMINI_YOUTUBE_MODEL, { youtubeAnalysis: true, videoInput: true });
    pushCandidate('openrouter', 'google/gemini-2.0-flash-001', { youtubeAnalysis: true });
  } else if (taskType === 'ocr') {
    pushCandidate('openai', OPENAI_DOC_MODEL, { ocr: true });
    pushCandidate('gemini', GEMINI_DOC_MODEL, { ocr: true });
    pushCandidate('anthropic', ANTHROPIC_DOC_MODEL, { ocr: true });
    pushCandidate('openrouter', OPENROUTER_DOC_MODEL, { ocr: true });
  }

  return candidates;
}

function chooseBestToolRoute({
  taskType,
  providerStatus,
  preferredModel = '',
  registry,
  preferences = {},
}) {
  const candidates = buildToolCandidates({
    taskType,
    providerStatus,
    preferredModel,
    registry,
  });
  if (candidates.length === 0) {
    return { provider: '', model: '', score: 0, reason: 'No provider candidates available.' };
  }
  const scored = candidates.map((candidate) => ({
    ...candidate,
    score: scoreRouteCandidate(candidate, preferences),
    failureRate: getFailureRate(candidate.provider),
    avgLatencyMs: getAverageLatencyMs(candidate.provider),
  })).sort((a, b) => b.score - a.score);
  const winner = scored[0];
  return {
    provider: winner.provider,
    model: winner.model,
    score: winner.score,
    failureRate: winner.failureRate,
    avgLatencyMs: winner.avgLatencyMs,
    considered: scored,
    reason: `Selected ${winner.provider} with score ${winner.score}.`,
  };
}

function extractYouTubeUrls(input) {
  const text = String(input || '');
  const matches = text.match(YOUTUBE_URL_REGEX) || [];
  const seen = new Set();
  const urls = [];
  for (const match of matches) {
    const cleaned = String(match).replace(/[),.;]+$/, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

function detectRequestedArtifacts(prompt) {
  const text = String(prompt || '');
  const wantsGenerate = GENERATE_INTENT_REGEX.test(text);
  const formats = new Set();
  if (wantsGenerate && IMAGE_INTENT_REGEX.test(text)) {
    formats.add('image');
  }
  if (wantsGenerate && PDF_INTENT_REGEX.test(text)) {
    formats.add('pdf');
  }
  if (wantsGenerate && DOCX_INTENT_REGEX.test(text)) {
    formats.add('docx');
  }
  if (wantsGenerate && XLSX_INTENT_REGEX.test(text)) {
    formats.add('xlsx');
  }
  return Array.from(formats);
}

function truncateText(value, maxChars = 7000) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...(truncated)`;
}

function sanitizeFileBasename(value, fallback = 'artifact') {
  const cleaned = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

function markdownToPlainText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/\r\n/g, '\n')
    .trim();
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toDataUrl(mimeType, buffer) {
  const encoded = Buffer.from(buffer).toString('base64');
  return `data:${mimeType};base64,${encoded}`;
}

function detectMimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return '';
  const asHex = buffer.subarray(0, 12).toString('hex').toLowerCase();
  if (asHex.startsWith('25504446')) return 'application/pdf';
  if (asHex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (asHex.startsWith('ffd8ff')) return 'image/jpeg';
  if (asHex.startsWith('47494638')) return 'image/gif';
  if (buffer.subarray(0, 2).toString('hex') === '504b') return 'application/zip';
  if (asHex.startsWith('3c3f786d6c') || buffer.subarray(0, 100).toString('utf8').includes('<svg')) return 'image/svg+xml';
  return '';
}

function readUInt32LE(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  return buffer.readUInt32LE(offset);
}

function inspectZipSafety(buffer) {
  try {
    const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const searchStart = Math.max(0, buffer.length - 0xffff - 22);
    const eocdOffset = buffer.lastIndexOf(signature);
    if (eocdOffset < 0 || eocdOffset < searchStart) {
      return { ok: false, reason: 'Missing ZIP central directory.' };
    }
    const centralDirectorySize = readUInt32LE(buffer, eocdOffset + 12);
    const centralDirectoryOffset = readUInt32LE(buffer, eocdOffset + 16);
    if (centralDirectorySize == null || centralDirectoryOffset == null) {
      return { ok: false, reason: 'Invalid ZIP EOCD fields.' };
    }
    if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
      return { ok: false, reason: 'Corrupt ZIP central directory.' };
    }

    let ptr = centralDirectoryOffset;
    let totalCompressed = 0;
    let totalUncompressed = 0;
    const fileNames = [];
    let entries = 0;
    while (ptr < centralDirectoryOffset + centralDirectorySize) {
      if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
      const compressedSize = readUInt32LE(buffer, ptr + 20) || 0;
      const uncompressedSize = readUInt32LE(buffer, ptr + 24) || 0;
      const fileNameLength = buffer.readUInt16LE(ptr + 28);
      const extraLength = buffer.readUInt16LE(ptr + 30);
      const commentLength = buffer.readUInt16LE(ptr + 32);
      const fileNameStart = ptr + 46;
      const fileNameEnd = fileNameStart + fileNameLength;
      const fileName = buffer.subarray(fileNameStart, fileNameEnd).toString('utf8');
      fileNames.push(fileName);
      entries += 1;
      totalCompressed += compressedSize;
      totalUncompressed += uncompressedSize;
      ptr = fileNameEnd + extraLength + commentLength;
    }

    const ratio = totalCompressed > 0 ? totalUncompressed / totalCompressed : 1;
    const hasMacroPayload = fileNames.some((name) => /vbaProject\.bin/i.test(name));
    if (entries > 1500) {
      return { ok: false, reason: 'ZIP has too many entries.', entries, ratio, hasMacroPayload, fileNames };
    }
    if (ratio > 80) {
      return { ok: false, reason: 'ZIP compression ratio looks unsafe.', entries, ratio, hasMacroPayload, fileNames };
    }
    return {
      ok: true,
      entries,
      ratio,
      hasMacroPayload,
      fileNames,
    };
  } catch {
    return { ok: false, reason: 'Failed to inspect ZIP structure.' };
  }
}

function scanBufferForMalwareHeuristics(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { suspicious: false };
  const head = buffer.subarray(0, 4096).toString('utf8').toLowerCase();
  const binaryHead = buffer.subarray(0, 2).toString('hex');
  if (binaryHead === '4d5a') {
    return { suspicious: true, reason: 'Executable (MZ) header detected.' };
  }
  const suspiciousRegex = /(powershell\s+-enc|frombase64string\(|wscript\.shell|cmd\.exe|javascript:|<script\b)/i;
  if (suspiciousRegex.test(head)) {
    return { suspicious: true, reason: 'Potentially malicious script signature detected.' };
  }
  return { suspicious: false };
}

function validateGeneratedArtifact({ format, mimeType, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'Generated artifact buffer was empty.' };
  }
  if (buffer.length > DOC_GENERATION_MAX_BYTES) {
    return { ok: false, reason: `Generated artifact exceeds limit (${DOC_GENERATION_MAX_BYTES} bytes).` };
  }
  const sniffed = detectMimeFromBuffer(buffer);
  if (format === 'pdf' && sniffed && sniffed !== 'application/pdf') {
    return { ok: false, reason: 'PDF signature mismatch.' };
  }
  if (['docx', 'xlsx'].includes(format) && sniffed && sniffed !== 'application/zip') {
    return { ok: false, reason: `${format.toUpperCase()} signature mismatch.` };
  }
  if (format === 'image' && sniffed && !sniffed.startsWith('image/')) {
    return { ok: false, reason: 'Image signature mismatch.' };
  }
  if (mimeType.includes('spreadsheetml') || mimeType.includes('wordprocessingml') || sniffed === 'application/zip') {
    const zipSafety = inspectZipSafety(buffer);
    if (!zipSafety.ok) {
      return { ok: false, reason: zipSafety.reason || 'ZIP safety validation failed.' };
    }
    if (zipSafety.hasMacroPayload) {
      return { ok: false, reason: 'Macro payload detected in generated Office file.' };
    }
  }
  const malware = scanBufferForMalwareHeuristics(buffer);
  if (malware.suspicious) {
    return { ok: false, reason: malware.reason || 'Malware heuristics flagged artifact.' };
  }
  return { ok: true };
}

function sliceBalancedObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
      if (depth < 0) return null;
    }
  }
  return null;
}

function extractJsonObjectContainingKey(text, requiredKey) {
  const source = String(text || '');
  const keyToken = `"${requiredKey}"`;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '{') continue;
    const candidate = sliceBalancedObject(source, i);
    if (!candidate || !candidate.includes(keyToken)) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, requiredKey)) {
        return parsed;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function pickToolModel(providerStatus, preferredModel = '') {
  const preferred = parseModelTarget(preferredModel);
  if (preferred.provider === 'openai' && providerStatus.openai) {
    return { provider: 'openai', model: preferred.model || OPENAI_DOC_MODEL };
  }
  if (preferred.provider === 'anthropic' && providerStatus.anthropic) {
    return { provider: 'anthropic', model: preferred.model || ANTHROPIC_DOC_MODEL };
  }
  if (preferred.provider === 'gemini' && providerStatus.gemini) {
    return { provider: 'gemini', model: preferred.model || GEMINI_DOC_MODEL };
  }
  if (preferred.provider === 'openrouter' && providerStatus.openrouter) {
    return { provider: 'openrouter', model: preferred.model || OPENROUTER_DOC_MODEL };
  }

  if (providerStatus.openai) return { provider: 'openai', model: OPENAI_DOC_MODEL };
  if (providerStatus.anthropic) return { provider: 'anthropic', model: ANTHROPIC_DOC_MODEL };
  if (providerStatus.gemini) return { provider: 'gemini', model: GEMINI_DOC_MODEL };
  if (providerStatus.openrouter) return { provider: 'openrouter', model: OPENROUTER_DOC_MODEL };
  return { provider: '', model: '' };
}

async function runProviderCompletion({
  provider,
  model,
  messages,
  signal,
  clientApiKey,
}) {
  const startedAt = nowMs();
  try {
    let result;
    if (provider === 'openai') {
      result = await handleOpenAI({ model, messages, stream: false, signal });
    } else if (provider === 'anthropic') {
      result = await handleAnthropic({ model, messages, stream: false, signal });
    } else if (provider === 'gemini') {
      result = await handleGemini({ model, messages, stream: false, signal });
    } else if (provider === 'openrouter') {
      result = await handleOpenRouter({ model, messages, stream: false, signal, clientApiKey });
    } else {
      throw new Error(`Unsupported provider for completion: ${provider}`);
    }
    recordProviderHealth(provider, { success: true, durationMs: nowMs() - startedAt });
    return result;
  } catch (error) {
    recordProviderHealth(provider, {
      success: false,
      durationMs: nowMs() - startedAt,
      errorMessage: error?.message || String(error),
    });
    throw error;
  }
}

function normalizeStructuredDocumentPayload(raw, prompt, formats) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const fallbackTitle = String(prompt || 'Generated document').split('\n')[0].slice(0, 70) || 'Generated document';
  const title = String(payload.title || fallbackTitle).trim() || fallbackTitle;
  const summary = truncateText(payload.summary || payload.abstract || '');
  const markdown = truncateText(payload.markdown || payload.body || payload.content || prompt, 12000);
  const plainText = markdownToPlainText(markdown);

  const table = payload.table && typeof payload.table === 'object' ? payload.table : {};
  const headers = Array.isArray(table.headers)
    ? table.headers.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const rows = Array.isArray(table.rows)
    ? table.rows
      .filter((row) => Array.isArray(row))
      .map((row) => row.map((cell) => String(cell ?? '').trim()).slice(0, 20))
      .slice(0, 200)
    : [];
  const includeTable = formats.includes('xlsx') || headers.length > 0 || rows.length > 0;

  return {
    title,
    summary: summary || plainText.slice(0, 800),
    markdown,
    plainText,
    table: includeTable ? { headers, rows } : null,
  };
}

async function generateStructuredDocumentContent({
  prompt,
  formats,
  providerStatus,
  preferredModel,
  routingPreferences = {},
  capabilityRegistry,
  clientApiKey,
  signal,
}) {
  const toolModel = chooseBestToolRoute({
    taskType: 'documents',
    providerStatus,
    preferredModel,
    registry: capabilityRegistry,
    preferences: routingPreferences,
  });
  if (!toolModel.provider) {
    const fallback = normalizeStructuredDocumentPayload(null, prompt, formats);
    return { payload: fallback, route: { provider: 'none', model: 'none', fallback: true } };
  }

  const systemInstruction = [
    'You create downloadable artifacts for a multimodal chat assistant.',
    'Return ONLY JSON with this schema:',
    '{"title":"...", "summary":"...", "markdown":"...", "table":{"headers":["..."],"rows":[["..."]]}}',
    'If a table is not applicable, return an empty headers/rows array.',
    'Do not include markdown fences.',
  ].join(' ');

  const userInstruction = [
    `User request: ${prompt}`,
    `Target formats: ${formats.join(', ')}`,
    'Generate high-quality content suitable for these files.',
  ].join('\n\n');

  try {
    const result = await runProviderCompletion({
      provider: toolModel.provider,
      model: toolModel.model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userInstruction },
      ],
      signal,
      clientApiKey,
    });
    const content = String(result?.content || '').trim();
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = extractJsonObjectContainingKey(content, 'markdown');
    }
    const payload = normalizeStructuredDocumentPayload(parsed, prompt, formats);
    return {
      payload,
      route: {
        provider: toolModel.provider,
        model: toolModel.model,
        score: toolModel.score,
        reason: toolModel.reason,
        fallback: false,
      },
    };
  } catch {
    const fallback = normalizeStructuredDocumentPayload(null, prompt, formats);
    return {
      payload: fallback,
      route: {
        provider: toolModel.provider,
        model: toolModel.model,
        score: toolModel.score,
        reason: toolModel.reason,
        fallback: true,
      },
    };
  }
}

function createDocxTable(tableData) {
  if (!tableData) return null;
  const headers = Array.isArray(tableData.headers) ? tableData.headers : [];
  const rows = Array.isArray(tableData.rows) ? tableData.rows : [];
  if (headers.length === 0 && rows.length === 0) return null;

  const tableRows = [];
  if (headers.length > 0) {
    tableRows.push(
      new TableRow({
        children: headers.map((header) => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: String(header || ''), bold: true })] })],
        })),
      })
    );
  }
  for (const row of rows.slice(0, 200)) {
    tableRows.push(
      new TableRow({
        children: row.map((cell) => new TableCell({
          children: [new Paragraph(String(cell || ''))],
        })),
      })
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: tableRows,
  });
}

async function buildDocxBuffer(payload) {
  const sections = [];
  const title = payload.title || 'Generated document';
  const bodyLines = markdownToPlainText(payload.markdown).split('\n').map((line) => line.trim()).filter(Boolean);

  const children = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1,
    }),
  ];

  if (payload.summary) {
    children.push(new Paragraph({
      text: payload.summary,
    }));
  }

  for (const line of bodyLines.slice(0, 300)) {
    children.push(new Paragraph(line));
  }

  const table = createDocxTable(payload.table);
  if (table) {
    children.push(new Paragraph({ text: 'Table', heading: HeadingLevel.HEADING_2 }));
    children.push(table);
  }

  sections.push({ children });
  const doc = new DocxDocument({ sections });
  return DocxPacker.toBuffer(doc);
}

function createPdfBuffer(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 50,
      size: 'LETTER',
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(payload.title || 'Generated document');
    doc.moveDown(0.7);

    if (payload.summary) {
      doc.fontSize(11).text(payload.summary);
      doc.moveDown(0.8);
    }

    doc.fontSize(11).text(markdownToPlainText(payload.markdown || ''), {
      lineGap: 2,
    });

    if (payload.table && (payload.table.headers?.length || payload.table.rows?.length)) {
      doc.addPage();
      doc.fontSize(14).text('Table');
      doc.moveDown(0.6);
      const headers = payload.table.headers || [];
      if (headers.length > 0) {
        doc.fontSize(11).text(headers.join(' | '));
        doc.moveDown(0.4);
      }
      for (const row of (payload.table.rows || []).slice(0, 200)) {
        doc.fontSize(10).text(row.join(' | '));
      }
    }
    doc.end();
  });
}

async function buildXlsxBuffer(payload) {
  const workbook = new ExcelJS.Workbook();
  const infoSheet = workbook.addWorksheet('Summary');
  infoSheet.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 80 },
  ];
  infoSheet.addRow({ field: 'Title', value: payload.title || '' });
  infoSheet.addRow({ field: 'Summary', value: payload.summary || '' });
  infoSheet.addRow({ field: 'Generated', value: new Date().toISOString() });
  infoSheet.addRow({ field: 'Body', value: markdownToPlainText(payload.markdown || '') });

  const tableSheet = workbook.addWorksheet('Table');
  const headers = payload.table?.headers || [];
  const rows = payload.table?.rows || [];
  if (headers.length > 0) {
    tableSheet.addRow(headers);
  }
  for (const row of rows.slice(0, 400)) {
    tableSheet.addRow(row);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function attachmentCategoryFromFormat(format) {
  if (format === 'pdf') return 'pdf';
  if (format === 'docx') return 'word';
  if (format === 'xlsx') return 'excel';
  if (format === 'image') return 'image';
  return 'text';
}

async function persistArtifact({ fileName, mimeType, buffer, provenance }) {
  await ensureArtifactStoreDir();
  const artifactId = createId('artifact');
  const downloadToken = randomBytes(24).toString('hex');
  const ext = path.extname(fileName || '') || '';
  const storageName = `${artifactId}${ext}`;
  const storagePath = path.join(ARTIFACT_STORE_DIR, storageName);
  await fs.writeFile(storagePath, buffer);
  const tokenHash = createHash('sha256').update(downloadToken).digest('hex');
  const expiresAt = nowMs() + ARTIFACT_TTL_MS;
  artifactStore.set(artifactId, {
    id: artifactId,
    fileName,
    mimeType,
    path: storagePath,
    tokenHash,
    size: buffer.length,
    provenance,
    createdAt: nowMs(),
    expiresAt,
  });
  return {
    artifactId,
    downloadUrl: `/api/artifacts/${artifactId}?token=${downloadToken}`,
    expiresAt,
  };
}

async function makeGeneratedAttachment({
  format,
  fileName,
  mimeType,
  buffer,
  content,
  provenance,
}) {
  const safety = validateGeneratedArtifact({ format, mimeType, buffer });
  if (!safety.ok) {
    throw new Error(`Artifact blocked by security policy: ${safety.reason}`);
  }
  const persisted = await persistArtifact({ fileName, mimeType, buffer, provenance });
  const category = attachmentCategoryFromFormat(format);
  return {
    name: fileName,
    size: buffer.length,
    type: mimeType,
    category,
    dataUrl: null,
    downloadUrl: persisted.downloadUrl,
    expiresAt: persisted.expiresAt,
    storageId: persisted.artifactId,
    preview: category === 'image' ? 'image' : 'text',
    content: category === 'image' ? '' : (content || ''),
    generated: true,
    generatedFormat: format,
    provenance,
  };
}

function buildFallbackSvg(prompt) {
  const label = escapeXml(truncateText(prompt, 120));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)" />
  <rect x="72" y="72" width="880" height="880" rx="32" fill="#111827" stroke="#334155" stroke-width="4" />
  <text x="112" y="170" fill="#22d3ee" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="600">Generated Placeholder</text>
  <foreignObject x="112" y="220" width="800" height="720">
    <div xmlns="http://www.w3.org/1999/xhtml" style="color:#e2e8f0;font-size:30px;line-height:1.35;font-family:Segoe UI, Arial, sans-serif;white-space:pre-wrap;">
      ${label}
    </div>
  </foreignObject>
</svg>`;
}

async function generateImageAttachment({ prompt }) {
  const titleBase = sanitizeFileBasename(prompt, 'generated-image');
  const sourceUrls = extractYouTubeUrls(prompt);

  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_IMAGE_MODEL,
          prompt,
          size: '1024x1024',
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (b64) {
          const buffer = Buffer.from(b64, 'base64');
          return {
            attachment: await makeGeneratedAttachment({
              format: 'image',
              fileName: `${titleBase}.png`,
              mimeType: 'image/png',
              buffer,
              content: '',
              provenance: {
                stage: 'image_generation',
                provider: 'openai',
                model: OPENAI_IMAGE_MODEL,
                sourceUrls,
                generatedAt: new Date().toISOString(),
              },
            }),
            route: { provider: 'openai', model: OPENAI_IMAGE_MODEL, fallback: false },
          };
        }
      }
    } catch {
      // fall through to SVG fallback
    }
  }

  const svg = buildFallbackSvg(prompt);
  const svgBuffer = Buffer.from(svg, 'utf8');
  return {
    attachment: await makeGeneratedAttachment({
      format: 'image',
      fileName: `${titleBase}.svg`,
      mimeType: 'image/svg+xml',
      buffer: svgBuffer,
      content: '',
      provenance: {
        stage: 'image_generation',
        provider: 'local',
        model: 'svg-fallback',
        sourceUrls,
        generatedAt: new Date().toISOString(),
      },
    }),
    route: { provider: 'local', model: 'svg-fallback', fallback: true },
  };
}

function ensureYoutubeModel(selectedModels, providerStatus, registry, routingPreferences = {}) {
  const models = Array.isArray(selectedModels)
    ? selectedModels.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const hasGeminiModel = models.some((modelId) => {
    const { provider } = parseModelTarget(modelId);
    if (provider === 'gemini') return true;
    return String(modelId).toLowerCase().startsWith('google/gemini');
  });
  if (hasGeminiModel) {
    return { models: null, reason: 'Gemini model already selected.' };
  }

  const youtubeRoute = chooseBestToolRoute({
    taskType: 'youtube',
    providerStatus,
    preferredModel: '',
    registry,
    preferences: routingPreferences,
  });
  if (!youtubeRoute.provider) {
    return { models: null, reason: 'No Gemini-capable provider key available.' };
  }
  const preferredGemini = youtubeRoute.provider === 'gemini'
    ? `gemini:${youtubeRoute.model || GEMINI_YOUTUBE_MODEL}`
    : (youtubeRoute.model || 'google/gemini-2.0-flash-001');

  if (models.length === 0) {
    return {
      models: [preferredGemini],
      reason: `Selected ${preferredGemini} for YouTube handling.`,
      route: youtubeRoute,
    };
  }
  const next = [preferredGemini, ...models.slice(1)];
  return {
    models: next,
    reason: `Routed first model to ${preferredGemini} for YouTube handling.`,
    route: youtubeRoute,
  };
}

function safeBase64ToBuffer(data) {
  try {
    return Buffer.from(String(data || ''), 'base64');
  } catch {
    return null;
  }
}

function validateIncomingAttachments(rawAttachments = []) {
  const attachments = Array.isArray(rawAttachments) ? rawAttachments.slice(0, MULTIMODAL_MAX_ATTACHMENTS) : [];
  const accepted = [];
  const rejected = [];

  for (const attachment of attachments) {
    const name = String(attachment?.name || '').trim();
    const category = String(attachment?.category || 'text').toLowerCase();
    const declaredType = String(attachment?.type || '').toLowerCase();
    const declaredSize = Number(attachment?.size || 0);
    const parsed = parseDataUrl(attachment?.dataUrl || '');
    const contentPreview = truncateText(attachment?.content || '', 2500);
    if (!name) {
      rejected.push({ name: '(unnamed)', reason: 'Missing attachment name.' });
      continue;
    }

    if (!parsed) {
      // Text-only attachments are accepted without binary validation.
      accepted.push({
        name,
        category,
        type: declaredType || 'text/plain',
        size: declaredSize,
        dataUrl: null,
        content: contentPreview,
      });
      continue;
    }

    const binary = safeBase64ToBuffer(parsed.data);
    if (!binary || binary.length === 0) {
      rejected.push({ name, reason: 'Attachment payload could not be decoded.' });
      continue;
    }
    if (binary.length > DOC_GENERATION_MAX_BYTES) {
      rejected.push({ name, reason: `Attachment exceeds ${DOC_GENERATION_MAX_BYTES} byte limit.` });
      continue;
    }

    const sniffed = detectMimeFromBuffer(binary);
    if (declaredType && sniffed && declaredType !== sniffed && !(declaredType.includes('officedocument') && sniffed === 'application/zip')) {
      rejected.push({ name, reason: 'Attachment mime/type mismatch detected.' });
      continue;
    }

    if (sniffed === 'application/zip' || declaredType.includes('officedocument')) {
      const zipSafety = inspectZipSafety(binary);
      if (!zipSafety.ok) {
        rejected.push({ name, reason: zipSafety.reason || 'Unsafe ZIP payload.' });
        continue;
      }
      if (zipSafety.hasMacroPayload) {
        rejected.push({ name, reason: 'Attachment contains macro payload and was blocked.' });
        continue;
      }
    }

    if ((sniffed || declaredType).includes('pdf')) {
      const pageMatches = binary.toString('latin1').match(/\/Type\s*\/Page\b/g);
      const pageCount = Array.isArray(pageMatches) ? pageMatches.length : 0;
      if (pageCount > 500) {
        rejected.push({ name, reason: `PDF page count too high (${pageCount}).` });
        continue;
      }
    }

    const malware = scanBufferForMalwareHeuristics(binary);
    if (malware.suspicious) {
      rejected.push({ name, reason: malware.reason || 'Malware heuristics flagged this attachment.' });
      continue;
    }

    accepted.push({
      name,
      category,
      type: declaredType || parsed.mimeType || sniffed || 'application/octet-stream',
      size: binary.length,
      dataUrl: attachment.dataUrl,
      content: contentPreview,
    });
  }

  return { accepted, rejected };
}

async function extractFallbackInsights({
  attachments = [],
  youtubeUrls = [],
  providerStatus,
  preferredModel = '',
  routingPreferences = {},
  registry,
  clientApiKey,
  signal,
}) {
  const insights = [];
  const routing = [];

  const imagesForOcr = attachments
    .filter((attachment) => attachment?.category === 'image' && attachment?.dataUrl)
    .slice(0, 4);
  if (imagesForOcr.length > 0) {
    const ocrRoute = chooseBestToolRoute({
      taskType: 'ocr',
      providerStatus,
      preferredModel,
      registry,
      preferences: routingPreferences,
    });
    if (ocrRoute.provider) {
      routing.push({
        type: 'ocr',
        provider: ocrRoute.provider,
        model: ocrRoute.model,
        score: ocrRoute.score,
        reason: ocrRoute.reason,
      });
      for (const image of imagesForOcr) {
        try {
          const ocrMessages = [
            { role: 'system', content: 'Extract text from the image exactly as seen. Return concise plaintext.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: `Extract any text from this image attachment named "${image.name}".` },
                { type: 'image_url', image_url: { url: image.dataUrl } },
              ],
            },
          ];
          const ocrResult = await runProviderCompletion({
            provider: ocrRoute.provider,
            model: ocrRoute.model,
            messages: ocrMessages,
            signal,
            clientApiKey,
          });
          const extracted = truncateText(ocrResult?.content || '', 2800);
          if (extracted) {
            insights.push({
              source: image.name,
              type: 'ocr',
              text: extracted,
            });
          }
        } catch {
          // non-blocking fallback path
        }
      }
    }
  }

  if (youtubeUrls.length > 0) {
    const youtubeRoute = chooseBestToolRoute({
      taskType: 'youtube',
      providerStatus,
      preferredModel,
      registry,
      preferences: routingPreferences,
    });
    if (youtubeRoute.provider) {
      routing.push({
        type: 'youtube_transcription',
        provider: youtubeRoute.provider,
        model: youtubeRoute.model,
        score: youtubeRoute.score,
        reason: youtubeRoute.reason,
      });
      try {
        const useVideoParts = youtubeRoute.provider === 'gemini';
        const youtubeContent = useVideoParts
          ? [
            { type: 'text', text: `Summarize these videos with timestamps and key claims:\n${youtubeUrls.map((url) => `- ${url}`).join('\n')}` },
            ...youtubeUrls.map((url) => ({ type: 'video_url', video_url: { url } })),
          ]
          : `Summarize these YouTube videos with approximate transcript highlights:\n${youtubeUrls.map((url) => `- ${url}`).join('\n')}`;

        const youtubeResult = await runProviderCompletion({
          provider: youtubeRoute.provider,
          model: youtubeRoute.model,
          messages: [
            { role: 'system', content: 'You are an analyst. Provide transcript-style highlights with timing cues when possible.' },
            { role: 'user', content: youtubeContent },
          ],
          signal,
          clientApiKey,
        });
        const summary = truncateText(youtubeResult?.content || '', 5000);
        if (summary) {
          insights.push({
            source: 'youtube',
            type: 'transcription_fallback',
            text: summary,
          });
        }
      } catch {
        // non-blocking fallback path
      }
    }
  }

  return { insights, routing };
}

async function executeMultimodalOrchestration({
  prompt = '',
  selectedModels = [],
  synthesizerModel = '',
  providerStatusInput = null,
  clientApiKey,
  attachments = [],
  routingPreferences = {},
  signal,
}) {
  const providerStatus = getServerProviderStatus(providerStatusInput);
  if (clientApiKey) {
    providerStatus.openrouter = true;
  }
  const capabilityRegistry = buildCapabilityRegistry(providerStatus);
  const userPrompt = String(prompt || '').trim();
  const requestedFormats = detectRequestedArtifacts(userPrompt);
  const youtubeUrls = extractYouTubeUrls(userPrompt);
  const attachmentValidation = validateIncomingAttachments(attachments);
  const safeAttachments = attachmentValidation.accepted;

  const generatedAttachments = [];
  const routingDecisions = [];
  let modelOverrides = null;

  if (youtubeUrls.length > 0) {
    const route = ensureYoutubeModel(selectedModels, providerStatus, capabilityRegistry, routingPreferences);
    if (route.models) {
      modelOverrides = route.models;
    }
    routingDecisions.push({
      type: 'youtube',
      youtubeUrls,
      reason: route.reason,
      provider: route.route?.provider || null,
      model: route.route?.model || null,
      score: route.route?.score || null,
    });
  }

  const extractionFallback = await extractFallbackInsights({
    attachments: safeAttachments,
    youtubeUrls,
    providerStatus,
    preferredModel: synthesizerModel,
    routingPreferences,
    registry: capabilityRegistry,
    clientApiKey,
    signal,
  });
  routingDecisions.push(...extractionFallback.routing);

  const requestedDocFormats = requestedFormats.filter((format) => format !== 'image');
  if (requestedDocFormats.length > 0) {
    const structured = await generateStructuredDocumentContent({
      prompt: userPrompt,
      formats: requestedDocFormats,
      providerStatus,
      preferredModel: synthesizerModel,
      routingPreferences,
      capabilityRegistry,
      clientApiKey,
      signal,
    });

    const payload = structured.payload;
    const basename = sanitizeFileBasename(payload.title || userPrompt, 'generated-document');

    for (const format of requestedDocFormats) {
      if (signal?.aborted) throw new Error('Orchestration aborted');
      if (format === 'pdf') {
        const buffer = await createPdfBuffer(payload);
        generatedAttachments.push(await makeGeneratedAttachment({
          format,
          fileName: `${basename}.pdf`,
          mimeType: 'application/pdf',
          buffer,
          content: payload.plainText,
          provenance: {
            stage: 'document_generation',
            provider: structured.route.provider,
            model: structured.route.model,
            sourceUrls: youtubeUrls,
            routingScore: structured.route.score ?? null,
            generatedAt: new Date().toISOString(),
          },
        }));
      } else if (format === 'docx') {
        const buffer = await buildDocxBuffer(payload);
        generatedAttachments.push(await makeGeneratedAttachment({
          format,
          fileName: `${basename}.docx`,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer,
          content: payload.plainText,
          provenance: {
            stage: 'document_generation',
            provider: structured.route.provider,
            model: structured.route.model,
            sourceUrls: youtubeUrls,
            routingScore: structured.route.score ?? null,
            generatedAt: new Date().toISOString(),
          },
        }));
      } else if (format === 'xlsx') {
        const buffer = await buildXlsxBuffer(payload);
        generatedAttachments.push(await makeGeneratedAttachment({
          format,
          fileName: `${basename}.xlsx`,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer,
          content: payload.plainText,
          provenance: {
            stage: 'document_generation',
            provider: structured.route.provider,
            model: structured.route.model,
            sourceUrls: youtubeUrls,
            routingScore: structured.route.score ?? null,
            generatedAt: new Date().toISOString(),
          },
        }));
      }
    }
    routingDecisions.push({
      type: 'documents',
      formats: requestedDocFormats,
      provider: structured.route.provider,
      model: structured.route.model,
      score: structured.route.score ?? null,
      reason: structured.route.reason || null,
      fallback: structured.route.fallback,
    });
  }

  if (requestedFormats.includes('image')) {
    const imageResult = await generateImageAttachment({ prompt: userPrompt });
    generatedAttachments.push(imageResult.attachment);
    routingDecisions.push({
      type: 'image',
      provider: imageResult.route.provider,
      model: imageResult.route.model,
      fallback: imageResult.route.fallback,
    });
  }

  const promptAugmentationParts = [];
  if (youtubeUrls.length > 0) {
    promptAugmentationParts.push(
      `YouTube URLs detected for analysis:\n${youtubeUrls.map((url) => `- ${url}`).join('\n')}`
    );
  }
  if (extractionFallback.insights.length > 0) {
    const insightText = extractionFallback.insights
      .map((item) => `- ${item.type} (${item.source}): ${truncateText(item.text, 900)}`)
      .join('\n');
    promptAugmentationParts.push(`Fallback extraction insights:\n${insightText}`);
  }
  if (generatedAttachments.length > 0) {
    promptAugmentationParts.push(
      `Generated artifacts attached (${generatedAttachments.length}): ${generatedAttachments.map((item) => item.name).join(', ')}`
    );
  }
  if (attachmentValidation.rejected.length > 0) {
    promptAugmentationParts.push(
      `Blocked attachments for security:\n${attachmentValidation.rejected.map((item) => `- ${item.name}: ${item.reason}`).join('\n')}`
    );
  }

  return {
    handled: generatedAttachments.length > 0 || youtubeUrls.length > 0 || extractionFallback.insights.length > 0,
    modelOverrides,
    generatedAttachments,
    youtubeUrls,
    promptAugmentation: promptAugmentationParts.join('\n\n'),
    routingDecisions,
    rejectedAttachments: attachmentValidation.rejected,
    capabilityRegistry,
  };
}

function buildMultimodalRequestPayload(body = {}) {
  return {
    prompt: body?.prompt || '',
    selectedModels: body?.selectedModels || [],
    synthesizerModel: body?.synthesizerModel || '',
    providerStatusInput: body?.providerStatus || null,
    clientApiKey: body?.clientApiKey,
    attachments: body?.attachments || [],
    routingPreferences: body?.routingPreferences || {},
  };
}

function getReusableMultimodalJob(payload) {
  const fingerprint = buildMultimodalJobFingerprint(payload);
  const existingJobId = multimodalJobFingerprints.get(fingerprint);
  if (!existingJobId) {
    return { fingerprint, job: null };
  }

  const existingJob = multimodalJobs.get(existingJobId);
  if (!existingJob || existingJob.expiresAt <= nowMs() || existingJob.status === 'failed') {
    multimodalJobFingerprints.delete(fingerprint);
    return { fingerprint, job: null };
  }

  return { fingerprint, job: existingJob };
}

function enqueueMultimodalJob(payload) {
  const { fingerprint, job: existingJob } = getReusableMultimodalJob(payload);
  if (existingJob) {
    return existingJob;
  }

  const jobId = createId('mmjob');
  const job = {
    id: jobId,
    status: 'pending',
    createdAt: nowMs(),
    updatedAt: nowMs(),
    expiresAt: nowMs() + JOB_TTL_MS,
    fingerprint,
    payload,
    result: null,
    error: null,
  };
  multimodalJobs.set(jobId, job);
  multimodalJobFingerprints.set(fingerprint, jobId);
  multimodalQueue.push(jobId);
  scheduleMultimodalWorker();
  return job;
}

function scheduleMultimodalWorker() {
  if (multimodalWorkerRunning) return;
  multimodalWorkerRunning = true;
  setImmediate(async () => {
    while (multimodalQueue.length > 0) {
      const jobId = multimodalQueue.shift();
      const job = multimodalJobs.get(jobId);
      if (!job || job.status !== 'pending') continue;
      job.status = 'running';
      job.updatedAt = nowMs();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), MAX_JOB_POLL_MS);
      try {
        job.result = await executeMultimodalOrchestration({
          ...job.payload,
          signal: controller.signal,
        });
        job.status = 'completed';
      } catch (error) {
        job.status = 'failed';
        job.error = error?.message || String(error);
        if (job.fingerprint && multimodalJobFingerprints.get(job.fingerprint) === jobId) {
          multimodalJobFingerprints.delete(job.fingerprint);
        }
      } finally {
        clearTimeout(timeoutId);
        job.updatedAt = nowMs();
      }
    }
    multimodalWorkerRunning = false;
  });
}

app.post('/api/multimodal/orchestrate', async (req, res) => {
  const payload = buildMultimodalRequestPayload(req.body);
  const { signal } = createRequestAbortContext(req, res);
  try {
    const { job } = getReusableMultimodalJob(payload);
    if (job?.status === 'completed') {
      res.json(job.result);
      return;
    }
    if (job && (job.status === 'pending' || job.status === 'running')) {
      res.status(202).json({
        jobId: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        expiresAt: job.expiresAt,
      });
      return;
    }

    const result = await executeMultimodalOrchestration({
      ...payload,
      signal,
    });
    if (signal.aborted || req.aborted || res.writableEnded) {
      return;
    }
    res.json(result);
  } catch (error) {
    if (signal.aborted || req.aborted || res.writableEnded) {
      return;
    }
    res.status(500).json({ error: error?.message || 'Multimodal orchestration failed.' });
  }
});

app.get('/api/capabilities', (req, res) => {
  const providerStatus = getServerProviderStatus(null);
  const capabilityRegistry = buildCapabilityRegistry(providerStatus);
  const providerHealthSnapshot = buildProviderHealthSnapshot();
  res.json({
    capabilityRegistry,
    providerHealth: providerHealthSnapshot,
    limits: {
      maxAttachments: MULTIMODAL_MAX_ATTACHMENTS,
      maxArtifactBytes: DOC_GENERATION_MAX_BYTES,
      artifactTtlMs: ARTIFACT_TTL_MS,
      jobTtlMs: JOB_TTL_MS,
      maxJobPollMs: MAX_JOB_POLL_MS,
    },
  });
});

app.post('/api/multimodal/jobs', async (req, res) => {
  const job = enqueueMultimodalJob(buildMultimodalRequestPayload(req.body));
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  });
});

app.get('/api/multimodal/jobs/:jobId', (req, res) => {
  const job = multimodalJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }
  const payload = {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
  if (job.status === 'completed') {
    payload.result = job.result;
  }
  if (job.status === 'failed') {
    payload.error = job.error || 'Job failed.';
  }
  res.json(payload);
});

app.get('/api/artifacts/:artifactId', async (req, res) => {
  const artifact = artifactStore.get(req.params.artifactId);
  if (!artifact) {
    res.status(404).json({ error: 'Artifact not found.' });
    return;
  }
  if (artifact.expiresAt <= nowMs()) {
    artifactStore.delete(req.params.artifactId);
    fs.unlink(artifact.path).catch(() => {});
    res.status(410).json({ error: 'Artifact expired.' });
    return;
  }
  const token = String(req.query.token || '');
  if (!token) {
    res.status(403).json({ error: 'Missing artifact token.' });
    return;
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  if (!constantTimeEquals(tokenHash, artifact.tokenHash)) {
    res.status(403).json({ error: 'Invalid artifact token.' });
    return;
  }
  res.setHeader('Content-Type', artifact.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(path.resolve(artifact.path));
});

app.post('/api/chat', async (req, res) => {
  const { model, messages, stream, clientApiKey, nativeWebSearch } = req.body || {};
  const { provider, model: providerModel } = parseModelTarget(model);
  const useNativeWebSearch = nativeWebSearch === true;
  const { signal } = createRequestAbortContext(req, res);

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
        signal,
        clientApiKey,
        nativeWebSearch: useNativeWebSearch,
      });
    } else if (provider === 'anthropic') {
      result = await handleAnthropic({
        model: providerModel,
        messages,
        stream,
        res,
        signal,
        nativeWebSearch: useNativeWebSearch,
      });
    } else if (provider === 'openai') {
      result = await handleOpenAI({
        model: providerModel,
        messages,
        stream,
        res,
        signal,
        nativeWebSearch: useNativeWebSearch,
      });
    } else if (provider === 'gemini') {
      result = await handleGemini({
        model: providerModel,
        messages,
        stream,
        res,
        signal,
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
