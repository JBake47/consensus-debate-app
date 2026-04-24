import { getModelImageSupport } from './modelCapabilities.js';
import { getTransportProviderId, usesOpenRouterTransport } from './modelTransport.js';
import { MAX_NATIVE_IMAGE_DIMENSION } from './attachmentLimits.js';

export const DEFAULT_MAX_ATTACHMENTS = 16;
export const ATTACHMENT_ACCEPTED_TYPES = [
  'Images',
  'PDF',
  'DOCX',
  'XLSX',
  'TXT',
  'Markdown',
  'CSV',
  'JSON',
  'Code files',
];
const PROMPT_CACHE_TEXT_MIN_CHARS = 4096;

function truncateContent(content, maxChars) {
  const text = String(content || '');
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function normalizeVideoUrls(videoUrls) {
  return Array.isArray(videoUrls)
    ? videoUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : [];
}

function getProviderCapabilities(providerId, capabilityRegistry) {
  return capabilityRegistry?.providers?.[providerId]?.capabilities || {};
}

function supportsNativeImage({ modelId, modelCatalog, capabilityRegistry }) {
  const transportProvider = getTransportProviderId(modelId);
  const providerCapabilities = getProviderCapabilities(transportProvider, capabilityRegistry);
  const hasProviderEntry = Boolean(capabilityRegistry?.providers && transportProvider in capabilityRegistry.providers);
  if (hasProviderEntry && !providerCapabilities.imageInput) return false;
  if (!usesOpenRouterTransport(modelId)) return true;
  const imageSupport = getModelImageSupport(modelCatalog?.[modelId]);
  return imageSupport !== false;
}

function exceedsNativeImageDimensionLimit(attachment) {
  const meta = attachment?.previewMeta || {};
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  if (width <= 0 || height <= 0) return false;
  return Math.max(width, height) > MAX_NATIVE_IMAGE_DIMENSION;
}

function supportsNativeVideo({ modelId, capabilityRegistry }) {
  const transportProvider = getTransportProviderId(modelId);
  return Boolean(getProviderCapabilities(transportProvider, capabilityRegistry).videoInput);
}

function getNativePdfSource(attachment) {
  const dataUrl = String(attachment?.dataUrl || '').trim();
  if (dataUrl.startsWith('data:application/pdf;base64,')) {
    return { type: 'file_data', value: dataUrl };
  }
  return null;
}

export function getPdfOcrCandidatePages(attachment) {
  return Array.isArray(attachment?.pdfOcrPages)
    ? attachment.pdfOcrPages.filter((page) => String(page?.dataUrl || '').startsWith('data:image/'))
    : [];
}

export function isPdfOcrRequired(attachment) {
  if (String(attachment?.category || '').toLowerCase() !== 'pdf') return false;
  const status = String(attachment?.pdfOcrStatus || '').toLowerCase();
  const meta = attachment?.previewMeta || {};
  const content = String(attachment?.content || '').trim();
  if (!content && meta.hasTextLayer !== true) return true;
  return Boolean(
    attachment?.pdfRequiresOcr
      || status === 'pending'
      || status === 'completed'
      || meta.needsOcr
      || meta.hasTextLayer === false
  );
}

function buildFallbackAttachmentBlock(attachment) {
  const category = String(attachment?.category || 'file').toLowerCase();
  const pdfNeedsOcr = category === 'pdf' && isPdfOcrRequired(attachment);
  const label = category === 'pdf'
    ? (pdfNeedsOcr ? 'Attached PDF OCR text' : 'Attached PDF fallback text')
    : category === 'word'
      ? 'Attached Word fallback text'
      : category === 'excel'
        ? 'Attached spreadsheet fallback text'
        : category === 'image'
          ? 'Attached image OCR text'
        : 'Attached file text';
  const content = String(attachment?.content || '').trim();
  if (!content) {
    const reason = pdfNeedsOcr
      ? 'OCR text is not available for this scanned/image-only PDF.'
      : 'Unable to extract text content from this file.';
    return `\n\n---\n**${label}: ${attachment?.name || 'attachment'}**\n(${reason})`;
  }
  return `\n\n---\n**${label}: ${attachment?.name || 'attachment'}**\n\`\`\`\n${truncateContent(content, 50000)}\n\`\`\``;
}

function getCacheModelId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (raw.startsWith('openrouter/')) return raw.slice('openrouter/'.length);
  if (raw.includes(':')) return raw.slice(raw.indexOf(':') + 1);
  return raw;
}

function isClaudeModel(modelId) {
  const id = getCacheModelId(modelId);
  return id.startsWith('anthropic/') || id.startsWith('claude-') || id.includes('/claude-');
}

function isOpenRouterGeminiModel(modelId) {
  if (!usesOpenRouterTransport(modelId)) return false;
  const id = getCacheModelId(modelId);
  return id.startsWith('google/gemini') || id.startsWith('gemini') || id.includes('/gemini');
}

function supportsExplicitPromptCacheControl(modelId) {
  return isClaudeModel(modelId) || isOpenRouterGeminiModel(modelId);
}

function buildCacheControl() {
  return { type: 'ephemeral' };
}

function shouldOptimizeAttachmentPrefix(fallbackText) {
  if (!fallbackText || fallbackText.length < PROMPT_CACHE_TEXT_MIN_CHARS) return false;
  return true;
}

function buildVariableAttachmentTail({ text, videoUrls, excludedNotes }) {
  const parts = [`**User request:**\n${String(text || '')}`];
  if (videoUrls.length > 0) {
    parts.push(`**Referenced videos:**\n${videoUrls.map((url) => `- ${url}`).join('\n')}`);
  }
  if (excludedNotes.length > 0) {
    parts.push(`**Attachments not sent to this model:**\n${excludedNotes.join('\n')}`);
  }
  return parts.join('\n\n---\n');
}

export function getAttachmentTransportForModel(attachment, modelId, modelCatalog = {}, capabilityRegistry = null) {
  if (!attachment || typeof attachment !== 'object') {
    return { mode: 'excluded', label: 'Not sent', reason: 'Attachment is unavailable.' };
  }

  if (attachment.processingStatus === 'processing') {
    return { mode: 'processing', label: 'Processing', reason: 'Attachment is still being processed.' };
  }
  if (attachment.processingStatus === 'error' || attachment.category === 'error') {
    return { mode: 'error', label: 'Failed', reason: attachment.error || 'Attachment processing failed.' };
  }

  const category = String(attachment.category || 'text').toLowerCase();
  const transportProvider = getTransportProviderId(modelId);

  if (category === 'image') {
    if (attachment.dataUrl && exceedsNativeImageDimensionLimit(attachment)) {
      if (String(attachment.content || '').trim()) {
        return {
          mode: 'text_fallback',
          label: 'OCR fallback',
          reason: `This image exceeds the ${MAX_NATIVE_IMAGE_DIMENSION}px provider dimension limit, so OCR text will be sent instead.`,
        };
      }
      return {
        mode: 'excluded',
        label: 'Too large',
        reason: `This image exceeds the ${MAX_NATIVE_IMAGE_DIMENSION}px provider dimension limit. Reattach it so the app can resize it before sending.`,
      };
    }
    if (attachment.dataUrl && supportsNativeImage({ modelId, modelCatalog, capabilityRegistry })) {
      return { mode: 'native_image', label: 'Native image', reason: 'Image sent as a multimodal input.' };
    }
    if (String(attachment.content || '').trim()) {
      return {
        mode: 'text_fallback',
        label: 'OCR fallback',
        reason: 'OCR text from this image will be sent because the model cannot accept native image input.',
      };
    }
    return {
      mode: 'excluded',
      label: 'Not sent',
      reason: attachment.dataUrl
        ? 'This model cannot accept image attachments.'
        : 'Image data is unavailable. Reattach the original file to resend it.',
    };
  }

  if (category === 'pdf') {
    const nativePdfSource = getNativePdfSource(attachment);
    const pdfNeedsOcr = isPdfOcrRequired(attachment);
    if (pdfNeedsOcr) {
      if (attachment.content) {
        return {
          mode: 'text_fallback',
          label: 'OCR text',
          reason: 'OCR text from this scanned/image-only PDF will be sent instead of the PDF binary.',
        };
      }
      if (getPdfOcrCandidatePages(attachment).length > 0) {
        return {
          mode: 'text_fallback',
          label: 'OCR pending',
          reason: 'This scanned/image-only PDF will be OCR processed before sending.',
        };
      }
      return {
        mode: 'excluded',
        label: 'Needs OCR',
        reason: 'This PDF appears scanned/image-only, but OCR page images are unavailable. Reattach the original file or upload page images.',
      };
    }
    if (attachment.content) {
      return {
        mode: 'text_fallback',
        label: 'Extracted text',
        reason: nativePdfSource
          ? 'Extracted PDF text will be sent instead of the PDF binary to avoid provider parser failures.'
          : 'The PDF binary is unavailable, so extracted text will be used.',
      };
    }
    return {
      mode: 'excluded',
      label: 'Not sent',
      reason: 'The PDF cannot be sent natively and no extracted text is available.',
    };
  }

  if (category === 'word' || category === 'excel' || category === 'text') {
    if (attachment.content) {
      return {
        mode: 'text_fallback',
        label: category === 'text' ? 'Inline text' : 'Extracted text',
        reason: 'This file will be sent as extracted text inside the prompt.',
      };
    }
    return {
      mode: 'excluded',
      label: 'Not sent',
      reason: 'No extracted text is available for this file.',
    };
  }

  if (category === 'binary') {
    return {
      mode: 'excluded',
      label: 'Not sent',
      reason: 'Binary files without extracted text are not supported in chat yet.',
    };
  }

  return attachment.content
    ? {
      mode: 'text_fallback',
      label: 'Extracted text',
      reason: 'This attachment will be sent as text.',
    }
    : {
      mode: 'excluded',
      label: 'Not sent',
      reason: 'This attachment format is not currently supported.',
    };
}

function buildVideoTransportForModel(modelId, capabilityRegistry) {
  if (supportsNativeVideo({ modelId, capabilityRegistry })) {
    return { mode: 'native_video', label: 'Native video' };
  }
  return { mode: 'reference_only', label: 'Referenced URL' };
}

export function buildAttachmentRoutingOverview({
  attachments = [],
  models = [],
  modelCatalog = {},
  capabilityRegistry = null,
}) {
  const selectedModels = Array.isArray(models) ? models.filter(Boolean) : [];
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => {
    if (attachment?.processingStatus === 'processing') {
      return {
        state: 'processing',
        primaryLabel: 'Processing',
        primaryTone: 'processing',
        nativeModels: [],
        fallbackModels: [],
        excludedModels: [],
        reasonsByModel: {},
      };
    }
    if (attachment?.processingStatus === 'error' || attachment?.category === 'error') {
      return {
        state: 'error',
        primaryLabel: 'Failed',
        primaryTone: 'error',
        nativeModels: [],
        fallbackModels: [],
        excludedModels: selectedModels,
        reasonsByModel: Object.fromEntries(selectedModels.map((modelId) => [modelId, attachment?.error || 'Attachment processing failed.'])),
      };
    }

    const nativeModels = [];
    const fallbackModels = [];
    const excludedModels = [];
    const reasonsByModel = {};
    const routeModes = new Set();

    for (const modelId of selectedModels) {
      const route = getAttachmentTransportForModel(attachment, modelId, modelCatalog, capabilityRegistry);
      routeModes.add(route.mode);
      reasonsByModel[modelId] = route.reason || route.label;
      if (route.mode === 'native_image' || route.mode === 'native_file') {
        nativeModels.push(modelId);
      } else if (route.mode === 'text_fallback') {
        fallbackModels.push(modelId);
      } else if (route.mode !== 'processing') {
        excludedModels.push(modelId);
      }
    }

    let primaryLabel = 'Routing unavailable';
    let primaryTone = 'neutral';
    const category = String(attachment?.category || '').toLowerCase();
    const usesOcrFallback = fallbackModels.length > 0 && (
      category === 'image'
      || (category === 'pdf' && isPdfOcrRequired(attachment))
    );
    if (nativeModels.length > 0 && fallbackModels.length === 0 && excludedModels.length === 0) {
      primaryLabel = routeModes.has('native_file') ? 'Native file' : 'Native image';
      primaryTone = 'native';
    } else if (fallbackModels.length > 0 && nativeModels.length === 0 && excludedModels.length === 0) {
      primaryLabel = usesOcrFallback ? 'OCR fallback' : 'Text fallback';
      primaryTone = 'fallback';
    } else if (excludedModels.length === selectedModels.length && selectedModels.length > 0) {
      primaryLabel = 'Not sent';
      primaryTone = 'excluded';
    } else if (nativeModels.length > 0 || fallbackModels.length > 0) {
      primaryLabel = 'Mixed routing';
      primaryTone = 'mixed';
    }

    return {
      state: 'ready',
      primaryLabel,
      primaryTone,
      nativeModels,
      fallbackModels,
      excludedModels,
      reasonsByModel,
    };
  });
}

export function buildAttachmentContentForModel(text, attachments, options = {}) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const videoUrls = normalizeVideoUrls(options.videoUrls);
  const modelId = options.modelId || '';
  const modelCatalog = options.modelCatalog || {};
  const capabilityRegistry = options.capabilityRegistry || null;

  if (safeAttachments.length === 0 && videoUrls.length === 0) {
    return text;
  }

  const nativeParts = [];
  const fallbackBlocks = [];
  const excludedNotes = [];
  let bodyText = String(text || '');

  for (const attachment of safeAttachments) {
    const route = getAttachmentTransportForModel(attachment, modelId, modelCatalog, capabilityRegistry);
    if (route.mode === 'native_image') {
      nativeParts.push({
        type: 'image_url',
        image_url: { url: attachment.dataUrl },
      });
      continue;
    }
    if (route.mode === 'native_file' && route.source?.type === 'file_data') {
      nativeParts.push({
        type: 'file',
        file: {
          filename: attachment.name || 'attachment.pdf',
          file_data: route.source.value,
        },
      });
      continue;
    }
    if (route.mode === 'text_fallback') {
      fallbackBlocks.push(buildFallbackAttachmentBlock(attachment));
      continue;
    }
    if (route.mode === 'excluded' || route.mode === 'error') {
      excludedNotes.push(`- ${attachment.name || 'attachment'}: ${route.reason || route.label}`);
    }
  }

  const fallbackText = fallbackBlocks.join('');
  const optimizeAttachmentPrefix = shouldOptimizeAttachmentPrefix(fallbackText);
  if (fallbackBlocks.length > 0 && !optimizeAttachmentPrefix) {
    bodyText += fallbackText;
  }

  if (videoUrls.length > 0) {
    const videoRoute = buildVideoTransportForModel(modelId, capabilityRegistry);
    if (videoRoute.mode === 'native_video') {
      for (const url of videoUrls) {
        nativeParts.push({
          type: 'video_url',
          video_url: { url },
        });
      }
    }
    if (!optimizeAttachmentPrefix) {
      bodyText += `\n\n---\n**Referenced videos:**\n${videoUrls.map((url) => `- ${url}`).join('\n')}`;
    }
  }

  if (excludedNotes.length > 0 && !optimizeAttachmentPrefix) {
    bodyText += `\n\n---\n**Attachments not sent to this model:**\n${excludedNotes.join('\n')}`;
  }

  if (optimizeAttachmentPrefix) {
    const cacheableText = `**Reusable reference material:**${fallbackText}`;
    const variableText = buildVariableAttachmentTail({ text, videoUrls, excludedNotes });
    if (supportsExplicitPromptCacheControl(modelId)) {
      const cacheablePart = { type: 'text', text: cacheableText };
      cacheablePart.cache_control = buildCacheControl();
      return [
        cacheablePart,
        { type: 'text', text: variableText },
        ...nativeParts,
      ];
    }
    bodyText = `${cacheableText}\n\n---\n${variableText}`;
  }

  if (nativeParts.length === 0) {
    return bodyText;
  }

  return [
    { type: 'text', text: bodyText },
    ...nativeParts,
  ];
}

export function buildAttachmentMessagesForModels({
  models = [],
  systemMessages = [],
  conversationHistory = [],
  userMessageContent = '',
  attachments = [],
  modelCatalog = {},
  capabilityRegistry = null,
  videoUrls = [],
}) {
  const selectedModels = Array.isArray(models) ? models : [];
  return selectedModels.map((modelId) => ([
    ...(Array.isArray(systemMessages) ? systemMessages : []),
    ...(Array.isArray(conversationHistory) ? conversationHistory : []),
    {
      role: 'user',
      content: buildAttachmentContentForModel(userMessageContent, attachments, {
        modelId,
        modelCatalog,
        capabilityRegistry,
        videoUrls,
      }),
    },
  ]));
}
