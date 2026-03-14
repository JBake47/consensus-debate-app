export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
export const TEXT_EXTENSIONS = [
  '.txt', '.md', '.mdx', '.json', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.jsx',
  '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.rb',
  '.php', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.log', '.sql', '.r', '.swift', '.kt', '.scala', '.lua', '.pl', '.m', '.env',
  '.gitignore', '.dockerfile', '.makefile', '.rtf', '.csv', '.tsv',
];
export const BINARY_EXTENSIONS = ['.doc', '.docm', '.ppt', '.pptx', '.odp', '.odt', '.ods', '.pages', '.numbers', '.key'];
export const MAX_INLINE_BYTES = 40 * 1024 * 1024;
export const SERVER_TEXT_EXTRACTION_MAX_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS = 16;

/**
 * Determine the category of a file.
 */
export function getFileCategory(file) {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  const ext = getExtension(file.name);
  if (['.xlsx', '.xls', '.xlsm'].includes(ext)) return 'excel';
  if (['.docx'].includes(ext)) return 'word';
  if (['.pdf'].includes(ext)) return 'pdf';
  if (BINARY_EXTENSIONS.includes(ext)) return 'binary';
  if (TEXT_EXTENSIONS.includes(ext) || file.type.startsWith('text/')) return 'text';
  // Fallback: try to read as text
  return 'text';
}

function getExtension(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

/**
 * Process a file and return a structured attachment object.
 * Returns { name, size, type, category, content, preview }
 *
 * For images: content is a data URL (base64)
 * For text/docs: content is the extracted text
 */
export async function processFile(file) {
  const category = getFileCategory(file);
  const canInline = file.size <= MAX_INLINE_BYTES || category === 'image';
  const dataUrl = canInline ? await readAsDataURL(file) : null;
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
      const pdf = await readPdf(file);
      return {
        ...base,
        content: pdf.content,
        preview: 'text',
        previewMeta: {
          ...buildTextPreviewMeta(pdf.content),
          pageCount: pdf.pageCount,
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
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
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
    return {
      content: pages.join('\n\n') || '(No text content extracted from PDF)',
      pageCount: pdf.numPages || 0,
    };
  } catch {
    return {
      content: '(Failed to parse PDF -- the file may be scanned or encrypted)',
      pageCount: 0,
    };
  }
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
