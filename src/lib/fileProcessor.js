import { getFileCategory } from './fileTypes.js';
import { MAX_NATIVE_IMAGE_DIMENSION } from './attachmentLimits.js';

export { BINARY_EXTENSIONS, IMAGE_TYPES, TEXT_EXTENSIONS, getFileCategory } from './fileTypes.js';
export { MAX_NATIVE_IMAGE_DIMENSION } from './attachmentLimits.js';
export const MAX_INLINE_BYTES = 40 * 1024 * 1024;
export const SERVER_TEXT_EXTRACTION_MAX_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS = 16;
export const PDF_OCR_MAX_PAGES = 8;
export const PDF_TEXT_MAX_PAGES = 200;
export const PDF_TEXT_MAX_CHARS = 500_000;
const PROVIDER_SAFE_IMAGE_TYPE = 'image/jpeg';
const PROVIDER_SAFE_IMAGE_QUALITY = 0.9;
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

export function getPdfTextExtractionBudget(pageCount) {
  const normalizedPageCount = Number.isFinite(Number(pageCount))
    ? Math.max(0, Math.floor(Number(pageCount)))
    : 0;
  return {
    pageCount: normalizedPageCount,
    pageLimit: Math.min(PDF_TEXT_MAX_PAGES, normalizedPageCount),
    charLimit: PDF_TEXT_MAX_CHARS,
    pagesTruncated: normalizedPageCount > PDF_TEXT_MAX_PAGES,
  };
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
    case 'image': {
      const image = await prepareImageForNativeProviders(file, dataUrl);
      return {
        ...base,
        dataUrl: image.dataUrl,
        content: '',
        preview: 'image',
        previewMeta: image.previewMeta,
        inlineWarning: image.inlineWarning || base.inlineWarning,
      };
    }
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
      const textLimitWarning = pdf.textPagesTruncated
        ? `PDF text preview was limited to ${pdf.textPageLimit} page${pdf.textPageLimit === 1 ? '' : 's'} or ${pdf.textCharLimit.toLocaleString()} characters.`
        : null;
      const inlineWarning = needsOcr
        ? (
          ocrPages.length > 0
            ? `This PDF appears to be scanned or image-only. Prepared ${ocrPages.length} page image${ocrPages.length === 1 ? '' : 's'} for OCR before sending.`
            : 'This PDF appears to be scanned or image-only, but page images could not be prepared for OCR.'
        )
        : (pdf.parseFailed ? 'PDF text extraction failed; the file may be encrypted or malformed.' : (textLimitWarning || base.inlineWarning));
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
          textPageLimit: pdf.textPageLimit,
          textCharLimit: pdf.textCharLimit,
          textPagesTruncated: Boolean(pdf.textPagesTruncated),
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

export function getImageResizeDimensions(width, height, maxDimension = MAX_NATIVE_IMAGE_DIMENSION) {
  const sourceWidth = Number(width);
  const sourceHeight = Number(height);
  const limit = Number(maxDimension);
  if (
    !Number.isFinite(sourceWidth)
    || !Number.isFinite(sourceHeight)
    || !Number.isFinite(limit)
    || sourceWidth <= 0
    || sourceHeight <= 0
    || limit <= 0
  ) {
    return { width: 0, height: 0, resized: false, scale: 1 };
  }

  const maxSourceDimension = Math.max(sourceWidth, sourceHeight);
  if (maxSourceDimension <= limit) {
    return {
      width: Math.round(sourceWidth),
      height: Math.round(sourceHeight),
      resized: false,
      scale: 1,
    };
  }

  const scale = limit / maxSourceDimension;
  const cappedLimit = Math.floor(limit);
  return {
    width: Math.min(cappedLimit, Math.max(1, Math.floor(sourceWidth * scale))),
    height: Math.min(cappedLimit, Math.max(1, Math.floor(sourceHeight * scale))),
    resized: true,
    scale,
  };
}

async function prepareImageForNativeProviders(file, dataUrl) {
  const previewMeta = await readImageMeta(file, dataUrl);
  const dimensions = getImageResizeDimensions(previewMeta?.width, previewMeta?.height);
  if (!dimensions.resized) {
    return { dataUrl, previewMeta, inlineWarning: null };
  }

  const resizedDataUrl = await resizeImageDataUrl(file, dataUrl, dimensions);
  if (!resizedDataUrl) {
    return {
      dataUrl: null,
      previewMeta,
      inlineWarning: `This image is ${previewMeta.width}x${previewMeta.height}, which exceeds the ${MAX_NATIVE_IMAGE_DIMENSION}px provider limit. It could not be resized automatically, so it will not be sent as a native image.`,
    };
  }

  return {
    dataUrl: resizedDataUrl,
    previewMeta: {
      ...previewMeta,
      originalWidth: previewMeta.width,
      originalHeight: previewMeta.height,
      width: dimensions.width,
      height: dimensions.height,
      resizedForProvider: true,
      providerMaxDimension: MAX_NATIVE_IMAGE_DIMENSION,
    },
    inlineWarning: `Image resized from ${previewMeta.width}x${previewMeta.height} to ${dimensions.width}x${dimensions.height} for provider compatibility.`,
  };
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

async function loadImageSource(file, dataUrl) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through
    }
  }

  const source = String(dataUrl || '').trim();
  if (typeof Image !== 'undefined' && source) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image for resizing'));
      img.src = source;
    });
  }

  return null;
}

async function resizeImageDataUrl(file, dataUrl, dimensions) {
  const width = Number(dimensions?.width || 0);
  const height = Number(dimensions?.height || 0);
  if (width <= 0 || height <= 0) return '';

  const renderCanvas = createRenderCanvas(width, height);
  if (!renderCanvas) return '';

  let image = null;
  try {
    image = await loadImageSource(file, dataUrl);
    if (!image) return '';
    renderCanvas.context.drawImage(image, 0, 0, width, height);
    return await canvasToDataUrlWithOptions(
      renderCanvas.canvas,
      PROVIDER_SAFE_IMAGE_TYPE,
      PROVIDER_SAFE_IMAGE_QUALITY
    );
  } catch {
    return '';
  } finally {
    image?.close?.();
  }
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

async function destroyPdfDocument(pdf) {
  try {
    if (typeof pdf?.destroy === 'function') {
      await pdf.destroy();
    } else {
      pdf?.cleanup?.();
    }
  } catch {
    // Ignore teardown failures; extraction result has already been determined.
  }
}

function cleanupPdfPage(page) {
  try {
    page?.cleanup?.();
  } catch {
    // Ignore page cleanup failures; document teardown remains the final backstop.
  }
}

async function readPdf(file) {
  let pdf = null;
  try {
    const pdfjsLib = await loadPdfjs();
    const buffer = await readAsArrayBuffer(file);
    pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pages = [];
    const budget = getPdfTextExtractionBudget(pdf.numPages);
    let extractedChars = 0;
    let textPagesTruncated = budget.pagesTruncated;
    for (let i = 1; i <= budget.pageLimit; i++) {
      let page = null;
      try {
        page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(item => item.str).join(' ');
        if (text.trim()) {
          const pageText = `--- Page ${i} ---\n${text}`;
          const remainingChars = budget.charLimit - extractedChars;
          if (remainingChars <= 0) {
            textPagesTruncated = true;
            break;
          }
          const storedPageText = pageText.length > remainingChars
            ? pageText.slice(0, remainingChars)
            : pageText;
          pages.push(storedPageText);
          extractedChars += storedPageText.length;
          if (storedPageText.length < pageText.length || extractedChars >= budget.charLimit) {
            textPagesTruncated = true;
            break;
          }
        }
      } finally {
        cleanupPdfPage(page);
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
      textPageLimit: budget.pageLimit,
      textCharLimit: budget.charLimit,
      textPagesTruncated,
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
      textPageLimit: 0,
      textCharLimit: PDF_TEXT_MAX_CHARS,
      textPagesTruncated: false,
      ocrCandidatePages: [],
      ocrCandidatePagesTruncated: false,
      ocrPageRenderFailed: false,
      parseFailed: true,
    };
  } finally {
    await destroyPdfDocument(pdf);
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
  return canvasToDataUrlWithOptions(canvas, PDF_OCR_IMAGE_TYPE, PDF_OCR_IMAGE_QUALITY);
}

async function canvasToDataUrlWithOptions(canvas, type, quality) {
  if (typeof canvas?.toDataURL === 'function') {
    return canvas.toDataURL(type, quality);
  }
  if (typeof canvas?.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({
      type,
      quality,
    });
    const buffer = await blob.arrayBuffer();
    return `data:${type};base64,${arrayBufferToBase64(buffer)}`;
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
    let page = null;
    try {
      page = await pdf.getPage(pageNumber);
      const rendered = await renderPdfPageForOcr(page, pageNumber);
      if (rendered) {
        pages.push(rendered);
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    } finally {
      cleanupPdfPage(page);
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
