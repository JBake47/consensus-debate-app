export const PDF_PREVIEW_LOAD_TIMEOUT_MS = 12_000;
export const PDF_PREVIEW_RENDER_TIMEOUT_MS = 15_000;
export const MAX_INLINE_TEXT_PREVIEW_CHARS = 120_000;

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-httpd-php',
  'image/svg+xml',
]);

function normalize(value) {
  return String(value || '').trim();
}

function hasTextContent(attachment) {
  return normalize(attachment?.content).length > 0;
}

function isTextLikeMime(type) {
  return type.startsWith('text/') || TEXT_MIME_TYPES.has(type);
}

export function getAttachmentPrimarySource(attachment) {
  const downloadUrl = normalize(attachment?.downloadUrl);
  if (downloadUrl) return downloadUrl;
  const dataUrl = normalize(attachment?.dataUrl);
  return dataUrl || null;
}

export function getAttachmentPreviewModeLabel(mode) {
  switch (mode) {
    case 'pdfjs':
      return 'Pages';
    case 'browser':
      return 'Browser';
    case 'text':
      return 'Text';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'image':
      return 'Image';
    default:
      return 'Details';
  }
}

export function getAttachmentTypeLabel(attachment) {
  const category = normalize(attachment?.category).toLowerCase();
  const type = normalize(attachment?.type).toLowerCase();

  if (type.startsWith('video/')) return 'Video file';
  if (type.startsWith('audio/')) return 'Audio file';

  switch (category) {
    case 'image':
      return 'Image';
    case 'pdf':
      return 'PDF document';
    case 'word':
      return 'Word document';
    case 'excel':
      return 'Spreadsheet';
    case 'text':
      return 'Text document';
    case 'binary':
      return 'Binary file';
    case 'error':
      return 'Failed attachment';
    default:
      return type || 'File';
  }
}

export function getAttachmentPreviewFallbackMessage(attachment, previewPlan = null) {
  const plan = previewPlan || getAttachmentPreviewPlan(attachment);
  if (plan.kind === 'processing') {
    return 'This attachment is still being prepared.';
  }
  if (plan.kind === 'error') {
    return attachment?.error || 'This attachment could not be processed.';
  }
  if (plan.kind === 'binary') {
    return 'This file type cannot be previewed inline. Use download to inspect the original file.';
  }
  if (plan.kind === 'unsupported') {
    return 'Preview unavailable for this attachment.';
  }
  return attachment?.inlineWarning || 'Preview unavailable.';
}

export function getAttachmentTextPreview(content, maxChars = MAX_INLINE_TEXT_PREVIEW_CHARS) {
  const text = String(content || '');
  if (!text) {
    return {
      text: '',
      shownChars: 0,
      totalChars: 0,
      truncated: false,
    };
  }

  if (text.length <= maxChars) {
    return {
      text,
      shownChars: text.length,
      totalChars: text.length,
      truncated: false,
    };
  }

  return {
    text: `${text.slice(0, maxChars)}\n\n... (preview truncated)`,
    shownChars: maxChars,
    totalChars: text.length,
    truncated: true,
  };
}

export function getAttachmentPreviewPlan(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    return {
      kind: 'empty',
      source: null,
      modes: ['details'],
      initialMode: 'details',
      fallbackMode: 'details',
      pdfFallbackMode: 'details',
    };
  }

  const category = normalize(attachment.category).toLowerCase();
  const type = normalize(attachment.type).toLowerCase();
  const processingStatus = normalize(attachment.processingStatus).toLowerCase();
  const source = getAttachmentPrimarySource(attachment);
  const hasSource = Boolean(source);
  const sourceIsDataUrl = source?.startsWith('data:') || false;
  const hasText = hasTextContent(attachment);

  if (processingStatus === 'processing') {
    return {
      kind: 'processing',
      source,
      modes: ['details'],
      initialMode: 'details',
      fallbackMode: 'details',
      pdfFallbackMode: 'details',
    };
  }

  if (processingStatus === 'error' || category === 'error') {
    return {
      kind: 'error',
      source,
      modes: ['details'],
      initialMode: 'details',
      fallbackMode: 'details',
      pdfFallbackMode: 'details',
    };
  }

  if (category === 'image' && hasSource) {
    return {
      kind: 'image',
      source,
      modes: ['image'],
      initialMode: 'image',
      fallbackMode: 'details',
      pdfFallbackMode: 'details',
    };
  }

  if (category === 'pdf') {
    const modes = [];
    if (hasText) {
      modes.push('text');
    }
    if (hasSource && !sourceIsDataUrl) {
      modes.push('browser');
    }
    if (hasSource) {
      modes.push('pdfjs');
    }
    if (modes.length === 0) {
      modes.push('details');
    }
    const fallbackMode = hasText
      ? 'text'
      : (hasSource && !sourceIsDataUrl ? 'browser' : 'details');
    if (!modes.includes(fallbackMode)) {
      modes.unshift(fallbackMode);
    }
    return {
      kind: 'pdf',
      source,
      modes,
      initialMode: hasText ? 'text' : fallbackMode,
      fallbackMode,
      pdfFallbackMode: fallbackMode,
    };
  }

  if (type.startsWith('video/') && hasSource) {
    return {
      kind: 'video',
      source,
      modes: hasText ? ['video', 'text'] : ['video'],
      initialMode: 'video',
      fallbackMode: hasText ? 'text' : 'details',
      pdfFallbackMode: 'details',
    };
  }

  if (type.startsWith('audio/') && hasSource) {
    return {
      kind: 'audio',
      source,
      modes: hasText ? ['audio', 'text'] : ['audio'],
      initialMode: 'audio',
      fallbackMode: hasText ? 'text' : 'details',
      pdfFallbackMode: 'details',
    };
  }

  if (category === 'text' || category === 'word' || category === 'excel' || hasText || isTextLikeMime(type)) {
    return {
      kind: 'text',
      source,
      modes: hasText ? ['text'] : ['details'],
      initialMode: hasText ? 'text' : 'details',
      fallbackMode: 'details',
      pdfFallbackMode: 'details',
    };
  }

  if (hasSource) {
    return {
      kind: 'binary',
      source,
      modes: ['details'],
      initialMode: 'details',
      fallbackMode: 'details',
      pdfFallbackMode: 'details',
    };
  }

  return {
    kind: 'unsupported',
    source,
    modes: hasText ? ['text'] : ['details'],
    initialMode: hasText ? 'text' : 'details',
    fallbackMode: 'details',
    pdfFallbackMode: 'details',
  };
}
