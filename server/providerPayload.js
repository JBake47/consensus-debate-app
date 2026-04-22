import { buildOpenRouterPlugins, buildOpenRouterTools } from './openrouterPayload.js';
import {
  buildClaudePromptCacheControl,
  buildOpenAIPromptCacheOptions,
} from './promptCache.js';

export function splitSystemMessages(messages) {
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

export function normalizeParts(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

export function parseDataUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function isOpenRouterPdfFilePart(part) {
  if (part?.type !== 'file' || !part.file || typeof part.file !== 'object') return false;
  const fileData = String(part.file.file_data || part.file.data || '').trim().toLowerCase();
  const filename = String(part.file.filename || part.file.name || '').trim().toLowerCase();
  return fileData.startsWith('data:application/pdf;base64,') || filename.endsWith('.pdf');
}

export function stripOpenRouterPdfFileParts(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const strippedContent = message.content.filter((part) => !isOpenRouterPdfFilePart(part));
    if (strippedContent.length === message.content.length) return message;
    return {
      ...message,
      content: strippedContent.length > 0
        ? strippedContent
        : [{
          type: 'text',
          text: 'A PDF attachment was omitted because native PDF parsing is disabled. Reattach the PDF so the app can extract/OCR text before sending.',
        }],
    };
  });
}

function findTextPartIndex(content) {
  if (!Array.isArray(content)) return -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part = content[index];
    if (part?.type === 'text') return index;
  }
  return -1;
}

function hasCacheableText(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  return findTextPartIndex(content) >= 0;
}

function findAutoCacheControlMessageIndex(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  const stableEnd = Math.max(0, messages.length - 2);
  for (let index = stableEnd; index >= 0; index -= 1) {
    if (hasCacheableText(messages[index]?.content)) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (hasCacheableText(messages[index]?.content)) return index;
  }
  return -1;
}

export function applyAutoCacheControlToMessages(messages, cacheControl) {
  if (!cacheControl || !Array.isArray(messages)) return messages;
  const targetIndex = findAutoCacheControlMessageIndex(messages);
  if (targetIndex < 0) return messages;

  return messages.map((message, index) => {
    if (index !== targetIndex) return message;
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: [
          {
            type: 'text',
            text: message.content,
            cache_control: { ...cacheControl },
          },
        ],
      };
    }

    const partIndex = findTextPartIndex(message.content);
    if (partIndex < 0) return message;
    return {
      ...message,
      content: message.content.map((part, nextPartIndex) => (
        nextPartIndex === partIndex
          ? { ...part, cache_control: { ...cacheControl } }
          : part
      )),
    };
  });
}

export function buildAnthropicMessages(messages) {
  return (messages || []).map((message) => {
    const parts = normalizeParts(message.content).map((part) => {
      if (part.type === 'text') {
        const textPart = { type: 'text', text: part.text || '' };
        if (part.cache_control && typeof part.cache_control === 'object') {
          textPart.cache_control = part.cache_control;
        }
        return textPart;
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

export function buildGeminiContents(messages) {
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

export function buildOpenRouterChatBody({
  model,
  messages,
  stream,
  nativeWebSearch = false,
  openRouterWebSearchMode = 'server_tool',
  webSearchOptions = {},
  promptCache = {},
  pluginOptions = {},
} = {}) {
  const safeMessages = stripOpenRouterPdfFileParts(messages);
  const body = {
    model,
    messages: safeMessages,
    stream,
    include_reasoning: true,
  };
  const cacheControl = buildClaudePromptCacheControl({
    model,
    messages: safeMessages,
    enabled: promptCache.enabled,
    ttl: promptCache.claudeTtl,
  });
  if (cacheControl) {
    body.messages = applyAutoCacheControlToMessages(body.messages, cacheControl);
  }
  const useLegacyWebSearchPlugin = nativeWebSearch && openRouterWebSearchMode === 'plugin';
  const tools = buildOpenRouterTools({
    nativeWebSearch: nativeWebSearch && !useLegacyWebSearchPlugin,
    webSearchOptions,
  });
  if (tools.length > 0) {
    body.tools = tools;
  }
  const plugins = buildOpenRouterPlugins({
    legacyWebSearch: useLegacyWebSearchPlugin,
    messages: body.messages,
    webPluginId: pluginOptions.webPluginId,
    filePluginId: pluginOptions.filePluginId,
    pdfEngine: pluginOptions.pdfEngine,
    webSearchOptions,
  });
  if (plugins.length > 0) {
    body.plugins = plugins;
  }
  return body;
}

export function buildAnthropicChatBody({
  model,
  messages,
  stream,
  nativeWebSearch = false,
  promptCache = {},
  maxTokens = 64000,
  webSearchToolType = 'web_search_20250305',
} = {}) {
  const { system, messages: filtered } = splitSystemMessages(messages);
  const parsedMaxTokens = Number(maxTokens);
  const body = {
    model,
    max_tokens: Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0
      ? Math.floor(parsedMaxTokens)
      : 64000,
    messages: buildAnthropicMessages(filtered),
    stream,
  };
  if (system) body.system = system;
  const cacheControl = buildClaudePromptCacheControl({
    model,
    messages,
    enabled: promptCache.enabled,
    ttl: promptCache.claudeTtl,
  });
  if (cacheControl) {
    body.messages = applyAutoCacheControlToMessages(body.messages, cacheControl);
  }
  if (nativeWebSearch) {
    body.tools = [{ type: webSearchToolType, name: 'web_search' }];
    body.tool_choice = { type: 'auto' };
  }
  return body;
}

export function buildOpenAIChatBody({
  model,
  messages,
  stream,
  nativeWebSearch = false,
  promptCache = {},
  webSearchMode = 'web_search_options',
} = {}) {
  const body = {
    model,
    messages,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    ...buildOpenAIPromptCacheOptions({
      model,
      messages,
      enabled: promptCache.enabled,
      retention: promptCache.openaiRetention,
    }),
  };
  if (nativeWebSearch) {
    if (webSearchMode === 'tools') {
      body.tools = [{ type: 'web_search' }];
      body.tool_choice = 'auto';
    } else {
      body.web_search_options = {};
    }
  }
  return body;
}

export function buildGeminiGenerateContentBody({
  messages,
  nativeWebSearch = false,
  cachedContent = '',
} = {}) {
  const { system, messages: filtered } = splitSystemMessages(messages);
  const body = {
    contents: buildGeminiContents(filtered),
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (nativeWebSearch) {
    body.tools = [{ google_search: {} }];
  }
  if (cachedContent) {
    body.cachedContent = cachedContent;
  }
  return body;
}
