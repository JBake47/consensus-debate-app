import { buildOpenRouterPlugins, buildOpenRouterTools } from './openrouterPayload.js';
import {
  buildClaudePromptCacheControl,
  buildOpenAIPromptCacheOptions,
} from './promptCache.js';

export const MAX_PROVIDER_IMAGE_DIMENSION = 8000;
const IMAGE_DIMENSION_HEADER_MAX_BYTES = 512 * 1024;

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

function decodeBase64Prefix(data, maxBytes = IMAGE_DIMENSION_HEADER_MAX_BYTES) {
  const clean = String(data || '').replace(/\s/g, '');
  if (!clean) return null;
  const chars = Math.ceil(Math.max(1, maxBytes) / 3) * 4;
  try {
    return Buffer.from(clean.slice(0, chars), 'base64');
  } catch {
    return null;
  }
}

function parsePngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  const isPng = buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[12] === 0x49
    && buffer[13] === 0x48
    && buffer[14] === 0x44
    && buffer[15] === 0x52;
  if (!isPng) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseGifDimensions(buffer) {
  if (!buffer || buffer.length < 10) return null;
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function parseJpegDimensions(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;

    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;

    const isStartOfFrame = (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    );
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function readUInt24LE(buffer, offset) {
  if (!buffer || offset + 3 > buffer.length) return null;
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function parseWebpDimensions(buffer) {
  if (!buffer || buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return null;
  }

  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType === 'VP8X' && buffer.length >= 30) {
    const widthMinusOne = readUInt24LE(buffer, 24);
    const heightMinusOne = readUInt24LE(buffer, 27);
    if (widthMinusOne == null || heightMinusOne == null) return null;
    return {
      width: widthMinusOne + 1,
      height: heightMinusOne + 1,
    };
  }

  if (chunkType === 'VP8 ' && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunkType === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }

  return null;
}

export function getDataUrlImageDimensions(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed || !String(parsed.mimeType || '').toLowerCase().startsWith('image/')) return null;

  const buffer = decodeBase64Prefix(parsed.data);
  if (!buffer || buffer.length === 0) return null;
  const dimensions = parsePngDimensions(buffer)
    || parseJpegDimensions(buffer)
    || parseGifDimensions(buffer)
    || parseWebpDimensions(buffer);
  if (!dimensions) return null;

  const width = Number(dimensions.width);
  const height = Number(dimensions.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    width: Math.floor(width),
    height: Math.floor(height),
  };
}

function buildOversizedImageReplacement(dimensions, maxDimension = MAX_PROVIDER_IMAGE_DIMENSION) {
  const sizeText = dimensions?.width && dimensions?.height
    ? `${dimensions.width}x${dimensions.height}`
    : 'unknown dimensions';
  return {
    type: 'text',
    text: `[Image omitted: ${sizeText} exceeds the provider image dimension limit of ${maxDimension}px. Reattach the image so the app can resize it before sending.]`,
  };
}

function buildProviderRejectedImageReplacement(dimensions = null) {
  const sizeText = dimensions?.width && dimensions?.height
    ? ` (${dimensions.width}x${dimensions.height})`
    : '';
  return {
    type: 'text',
    text: `[Image omitted${sizeText}: the provider rejected the image size or dimensions. Reattach the image so the app can resize it before sending.]`,
  };
}

export function sanitizeOversizedImageParts(messages, maxDimension = MAX_PROVIDER_IMAGE_DIMENSION) {
  const limit = Number(maxDimension);
  if (!Number.isFinite(limit) || limit <= 0) return messages;

  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part?.type !== 'image_url' || !part.image_url?.url) return part;
      const dimensions = getDataUrlImageDimensions(part.image_url.url);
      if (!dimensions || Math.max(dimensions.width, dimensions.height) <= limit) return part;
      changed = true;
      return buildOversizedImageReplacement(dimensions, limit);
    });
    return changed ? { ...message, content } : message;
  });
}

export function replaceImagePartsWithText(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part?.type !== 'image_url' || !part.image_url?.url) return part;
      changed = true;
      return buildProviderRejectedImageReplacement(getDataUrlImageDimensions(part.image_url.url));
    });
    return changed ? { ...message, content } : message;
  });
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
  const safeMessages = sanitizeOversizedImageParts(messages);
  return (safeMessages || []).map((message) => {
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
  const safeMessages = sanitizeOversizedImageParts(messages);
  return (safeMessages || []).map((message) => {
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
  const safeMessages = stripOpenRouterPdfFileParts(sanitizeOversizedImageParts(messages));
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
  const safeMessages = sanitizeOversizedImageParts(messages);
  const { system, messages: filtered } = splitSystemMessages(safeMessages);
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
    messages: safeMessages,
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
  const safeMessages = sanitizeOversizedImageParts(messages);
  const body = {
    model,
    messages: safeMessages,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    ...buildOpenAIPromptCacheOptions({
      model,
      messages: safeMessages,
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
  const safeMessages = sanitizeOversizedImageParts(messages);
  const { system, messages: filtered } = splitSystemMessages(safeMessages);
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
