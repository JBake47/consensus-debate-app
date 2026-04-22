import { getFileCategory } from './fileTypes.js';

export { BINARY_EXTENSIONS, IMAGE_TYPES, TEXT_EXTENSIONS, getFileCategory } from './fileTypes.js';
export const MAX_INLINE_BYTES = 40 * 1024 * 1024;
export const SERVER_TEXT_EXTRACTION_MAX_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS = 16;
export const PDF_OCR_MAX_PAGES = 8;
const PDF_OCR_MAX_DIMENSION = 1800;
const PDF_OCR_MAX_PIXELS = 2_600_000;
const PDF_OCR_RENDER_SCALE = 2;
const PDF_OCR_IMAGE_TYPE = 'image/jpeg';
const PDF_OCR_IMAGE_QUALITY = 0.84;

export function hasUsefulPdfText(content) {
  const text = String(content || '')
    .replace(/--- Page \d+ ---/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0;
}

/**
 * Process a file and return a structured attachment object.
 * Returns { name, size, type, category, content, preview }
 *
 * For images: content is a data URL (base64)
 * For text/docs: content is the extracted text
 */
export async function processFile(file, options = {}) {
  const category = getFileCategory(file);
  const canInline = file.size <= MAX_INLINE_BYTES || category === 'image';
  const dataUrl = canInline ? await readAsDataURL(file) : null;
  const safePdfFallback = options?.safePdfFallback === true;
  const base = {
    name: file.name,
    size: file.size,
    type: file.type,
    category,
    dataUrl,
    inlineWarning: canInline ? null : 'File too large to store for preview. Reattach to view or download.',
    processingStatus: 'ready',
  };

  switch (category) {
    case 'image':
      return { ...base, content: '', preview: 'image', previewMeta: await readImageMeta(file, dataUrl) };
    case 'excel': {
      const content = await readOfficeDocument(file, 'excel');
      return { ...base, content, preview: 'text', previewMeta: buildTextPreviewMeta(content) };
    }
    case 'word': {
      const content = await readOfficeDocument(file, 'word');
      return { ...base, content, preview: 'text', previewMeta: buildTextPreviewMeta(content) };
    }
    case 'pdf': {
      if (safePdfFallback) {
        return {
          ...base,
          content: '',
          preview: 'binary',
          inlineWarning: canInline
            ? 'PDF text extraction was skipped after worker processing failed. Reattach the PDF to retry OCR before sending it to models.'
            : 'PDF text extraction was skipped after worker processing failed, and the file is too large to store inline for preview.',
          pdfRequiresOcr: true,
          pdfOcrStatus: 'unavailable',
          pdfOcrPages: [],
          previewMeta: {
            pageCount: 0,
            lineCount: 0,
            charCount: 0,
            hasTextLayer: false,
            needsOcr: true,
            ocrCandidatePageCount: 0,
            ocrCandidatePageLimit: PDF_OCR_MAX_PAGES,
            ocrCandidatePagesTruncated: false,
            ocrPageRenderFailed: true,
          },
        };
      }
      const pdf = await readPdf(file);
      const hasText = hasUsefulPdfText(pdf.content);
      const needsOcr = !pdf.parseFailed && !hasText && pdf.pageCount > 0;
      const ocrPages = Array.isArray(pdf.ocrCandidatePages) ? pdf.ocrCandidatePages : [];
      const inlineWarning = needsOcr
        ? (
          ocrPages.length > 0
            ? `This PDF appears to be scanned or image-only. Prepared ${ocrPages.length} page image${ocrPages.length === 1 ? '' : 's'} for OCR before sending.`
            : 'This PDF appears to be scanned or image-only, but page images could not be prepared for OCR.'
        )
        : (pdf.parseFailed ? 'PDF text extraction failed; the file may be encrypted or malformed.' : base.inlineWarning);
      return {
        ...base,
        content: pdf.content,
        preview: hasText ? 'text' : 'binary',
        inlineWarning,
        pdfRequiresOcr: needsOcr,
        pdfOcrStatus: needsOcr
          ? (ocrPages.length > 0 ? 'pending' : 'unavailable')
          : (hasText ? 'not_needed' : 'unavailable'),
        pdfOcrPages: ocrPages,
        previewMeta: {
          ...buildTextPreviewMeta(pdf.content),
          pageCount: pdf.pageCount,
          hasTextLayer: hasText,
          needsOcr,
          ocrCandidatePageCount: ocrPages.length,
          ocrCandidatePageLimit: PDF_OCR_MAX_PAGES,
          ocrCandidatePagesTruncated: Boolean(pdf.ocrCandidatePagesTruncated),
          ocrPageRenderFailed: Boolean(pdf.ocrPageRenderFailed),
        },
      };
    }
    case 'binary':
      return { ...base, content: '', preview: 'binary' };
    case 'text':
    default: {
      const content = await readAsText(file);
      return { ...base, content, preview: 'text', previewMeta: buildTextPreviewMeta(content) };
    }
  }
}

function buildTextPreviewMeta(content) {
  const text = String(content || '');
  return {
    lineCount: text ? text.split(/\r?\n/).length : 0,
    charCount: text.length,
  };
}

async function readAsDataURL(file) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  const buffer = await readAsArrayBuffer(file);
  const type = String(file?.type || 'application/octet-stream');
  return `data:${type};base64,${arrayBufferToBase64(buffer)}`;
}

async function readAsText(file) {
  if (typeof file?.text === 'function') {
    return file.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

async function readAsArrayBuffer(file) {
  if (typeof file?.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

async function readImageMeta(file, dataUrl) {
  const source = String(dataUrl || '').trim();
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const meta = {
        width: bitmap.width,
        height: bitmap.height,
      };
      bitmap.close?.();
      return meta;
    } catch {
      // fall through
    }
  }

  if (typeof Image !== 'undefined' && source) {
    try {
      const meta = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('Failed to read image dimensions'));
        img.src = source;
      });
      return meta;
    } catch {
      return null;
    }
  }

  return null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  throw new Error('Base64 encoding is unavailable in this environment');
}

async function readOfficeDocument(file, category) {
  if (file.size > SERVER_TEXT_EXTRACTION_MAX_BYTES) {
    return '(File too large to extract a text preview. Reattach it when sending if the model needs the full document.)';
  }

  try {
    const response = await fetch('/api/files/extract-text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file?.name || 'attachment'),
      },
      body: file,
    });

    if (!response.ok) {
      throw new Error(`Server extraction failed with status ${response.status}`);
    }

    const payload = await response.json();
    return typeof payload?.content === 'string'
      ? payload.content
      : '';
  } catch {
    return category === 'excel'
      ? '(Failed to extract spreadsheet text preview.)'
      : '(Failed to extract Word document text preview.)';
  }
}

let pdfjsLibPromise;

async function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjsLib, workerUrl]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.default || workerUrl;
      return pdfjsLib;
    });
  }
  return pdfjsLibPromise;
}

async function readPdf(file) {
  try {
    const pdfjsLib = await loadPdfjs();
    const buffer = await readAsArrayBuffer(file);
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      if (text.trim()) {
        pages.push(`--- Page ${i} ---\n${text}`);
      }
    }
    const hasText = pages.length > 0;
    const ocrResult = hasText
      ? { pages: [], truncated: false, failed: false }
      : await renderPdfOcrCandidatePages(pdf);
    return {
      content: pages.join('\n\n'),
      pageCount: pdf.numPages || 0,
      hasTextLayer: hasText,
      ocrCandidatePages: ocrResult.pages,
      ocrCandidatePagesTruncated: ocrResult.truncated,
      ocrPageRenderFailed: ocrResult.failed,
      parseFailed: false,
    };
  } catch {
    return {
      content: '',
      pageCount: 0,
      hasTextLayer: false,
      ocrCandidatePages: [],
      ocrCandidatePagesTruncated: false,
      ocrPageRenderFailed: false,
      parseFailed: true,
    };
  }
}

function createRenderCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    return context ? { canvas, context } : null;
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    return context ? { canvas, context } : null;
  }
  return null;
}

async function canvasToDataUrl(canvas) {
  if (typeof canvas?.toDataURL === 'function') {
    return canvas.toDataURL(PDF_OCR_IMAGE_TYPE, PDF_OCR_IMAGE_QUALITY);
  }
  if (typeof canvas?.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({
      type: PDF_OCR_IMAGE_TYPE,
      quality: PDF_OCR_IMAGE_QUALITY,
    });
    const buffer = await blob.arrayBuffer();
    return `data:${PDF_OCR_IMAGE_TYPE};base64,${arrayBufferToBase64(buffer)}`;
  }
  return '';
}

function getPdfOcrScale(viewport) {
  const width = Math.max(1, Number(viewport?.width || 1));
  const height = Math.max(1, Number(viewport?.height || 1));
  const maxDimensionScale = PDF_OCR_MAX_DIMENSION / Math.max(width, height);
  const maxPixelScale = Math.sqrt(PDF_OCR_MAX_PIXELS / (width * height));
  return Math.max(0.3, Math.min(PDF_OCR_RENDER_SCALE, maxDimensionScale, maxPixelScale));
}

async function renderPdfPageForOcr(page, pageNumber) {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = getPdfOcrScale(baseViewport);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const renderCanvas = createRenderCanvas(width, height);
  if (!renderCanvas) return null;

  await page.render({
    canvasContext: renderCanvas.context,
    viewport,
  }).promise;

  const dataUrl = await canvasToDataUrl(renderCanvas.canvas);
  if (!dataUrl) return null;
  return {
    pageNumber,
    dataUrl,
    width,
    height,
  };
}

async function renderPdfOcrCandidatePages(pdf) {
  const pageCount = Number(pdf?.numPages || 0);
  const maxPages = Math.min(PDF_OCR_MAX_PAGES, Math.max(0, pageCount));
  if (maxPages === 0) {
    return { pages: [], truncated: false, failed: false };
  }

  const pages = [];
  let failed = false;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    try {
      const page = await pdf.getPage(pageNumber);
      const rendered = await renderPdfPageForOcr(page, pageNumber);
      page.cleanup?.();
      if (rendered) {
        pages.push(rendered);
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    }
  }

  return {
    pages,
    truncated: pageCount > maxPages,
    failed,
  };
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
