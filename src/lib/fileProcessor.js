import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const TEXT_EXTENSIONS = [
  '.txt', '.md', '.mdx', '.json', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.jsx',
  '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.rb',
  '.php', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.log', '.sql', '.r', '.swift', '.kt', '.scala', '.lua', '.pl', '.m', '.env',
  '.gitignore', '.dockerfile', '.makefile', '.rtf', '.csv', '.tsv',
];
const BINARY_EXTENSIONS = ['.doc', '.docm', '.ppt', '.pptx', '.odp', '.odt', '.ods', '.pages', '.numbers', '.key'];
const MAX_INLINE_BYTES = 40 * 1024 * 1024;

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
  };

  switch (category) {
    case 'image':
      return { ...base, content: dataUrl, preview: 'image' };
    case 'excel':
      return { ...base, content: await readExcel(file), preview: 'text' };
    case 'word':
      return { ...base, content: await readWord(file), preview: 'text' };
    case 'pdf':
      return { ...base, content: await readPdf(file), preview: 'text' };
    case 'binary':
      return { ...base, content: '', preview: 'binary' };
    case 'text':
    default:
      return { ...base, content: await readAsText(file), preview: 'text' };
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

async function readExcel(file) {
  const buffer = await readAsArrayBuffer(file);
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }
  return sheets.join('\n\n');
}

async function readWord(file) {
  const buffer = await readAsArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
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
    return pages.join('\n\n') || '(No text content extracted from PDF)';
  } catch {
    return '(Failed to parse PDF -- the file may be scanned or encrypted)';
  }
}

/**
 * Build message content parts for attachments.
 * Returns an array suitable for OpenAI-style multimodal content.
 */
export function buildAttachmentContent(text, attachments) {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  const parts = [];

  // Add text attachments inline
  const textAttachments = attachments.filter(a => a.category !== 'image');
  if (textAttachments.length > 0) {
    const attachmentText = textAttachments
      .map(a => {
        if (a.content) {
          return `\n\n---\n**Attached file: ${a.name}**\n\`\`\`\n${truncateContent(a.content, 50000)}\n\`\`\``;
        }
        return `\n\n---\n**Attached file: ${a.name}**\n(Unable to extract text content from this file.)`;
      })
      .join('');
    text += attachmentText;
  }

  // For image attachments, use multimodal content format
  const imageAttachments = attachments.filter(a => a.category === 'image');
  if (imageAttachments.length > 0) {
    parts.push({ type: 'text', text });
    for (const img of imageAttachments) {
      parts.push({
        type: 'image_url',
        image_url: { url: img.content },
      });
    }
    return parts;
  }

  return text;
}

/**
 * Build text-only attachment content (no image parts) for text-only models.
 */
export function buildAttachmentTextContent(text, attachments) {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  const textAttachments = attachments.filter(a => a.category !== 'image');
  if (textAttachments.length > 0) {
    const attachmentText = textAttachments
      .map(a => {
        if (a.content) {
          return `\n\n---\n**Attached file: ${a.name}**\n\`\`\`\n${truncateContent(a.content, 50000)}\n\`\`\``;
        }
        return `\n\n---\n**Attached file: ${a.name}**\n(Unable to extract text content from this file.)`;
      })
      .join('');
    text += attachmentText;
  }

  const imageAttachments = attachments.filter(a => a.category === 'image');
  if (imageAttachments.length > 0) {
    const imageList = imageAttachments.map(a => a.name).join(', ');
    text += `\n\n---\n**Attached images (not included inline):** ${imageList}`;
  }

  return text;
}

function truncateContent(content, maxChars) {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n... (truncated)';
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
