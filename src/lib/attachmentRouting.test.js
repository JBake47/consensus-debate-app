import assert from 'node:assert/strict';
import {
  buildAttachmentContentForModel,
  buildAttachmentRoutingOverview,
} from './attachmentRouting.js';
import { buildAttachmentTextContent } from './attachmentContent.js';

const pdfAttachment = {
  name: 'brief.pdf',
  size: 2048,
  type: 'application/pdf',
  category: 'pdf',
  dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
  content: '--- Page 1 ---\nExample PDF text',
  processingStatus: 'ready',
};

const scannedPdfAttachment = {
  name: 'scan.pdf',
  size: 4096,
  type: 'application/pdf',
  category: 'pdf',
  dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
  content: '',
  processingStatus: 'ready',
  pdfRequiresOcr: true,
  pdfOcrStatus: 'pending',
  pdfOcrPages: [{
    pageNumber: 1,
    dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD',
    width: 1200,
    height: 1600,
  }],
  previewMeta: {
    pageCount: 1,
    hasTextLayer: false,
    needsOcr: true,
  },
};

const imageAttachment = {
  name: 'diagram.png',
  size: 1024,
  type: 'image/png',
  category: 'image',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  content: '',
  processingStatus: 'ready',
};

function test(name, fn) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

test('OpenRouter-routed PDFs use extracted text instead of native file parsing', () => {
  const content = buildAttachmentContentForModel('Review the attached brief.', [pdfAttachment], {
    modelId: 'anthropic/claude-3.7-sonnet',
  });
  assert.equal(typeof content, 'string');
  assert.equal(content.includes('Attached PDF fallback text: brief.pdf'), true);
  assert.equal(content.includes('Example PDF text'), true);
});

test('Direct-provider PDFs fall back to extracted text', () => {
  const content = buildAttachmentContentForModel('Review the attached brief.', [pdfAttachment], {
    modelId: 'anthropic:claude-sonnet-4-5',
  });
  assert.equal(typeof content, 'string');
  assert.equal(content.includes('Attached PDF fallback text: brief.pdf'), true);
  assert.equal(content.includes('Example PDF text'), true);
});

test('Scanned PDFs do not use native OpenRouter file parsing before OCR', () => {
  const content = buildAttachmentContentForModel('Review the scanned PDF.', [scannedPdfAttachment], {
    modelId: 'anthropic/claude-3.7-sonnet',
  });
  assert.equal(Array.isArray(content), false);
  assert.equal(content.includes('Attached PDF OCR text: scan.pdf'), true);
  assert.equal(content.includes('OCR text is not available'), true);
});

test('Legacy empty PDFs are never sent to OpenRouter native file parsing', () => {
  const content = buildAttachmentContentForModel('Review the attached PDF.', [{
    name: 'old-scan.pdf',
    size: 4096,
    type: 'application/pdf',
    category: 'pdf',
    dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
    content: '',
    processingStatus: 'ready',
  }], {
    modelId: 'anthropic/claude-3.7-sonnet',
  });
  assert.equal(Array.isArray(content), false);
  assert.equal(content.includes('Attachments not sent to this model'), true);
  assert.equal(content.includes('old-scan.pdf'), true);
  assert.equal(content.includes('Reattach the original file'), true);
});

test('OCR-completed scanned PDFs route as text fallback for OpenRouter models', () => {
  const content = buildAttachmentContentForModel('Review the scanned PDF.', [{
    ...scannedPdfAttachment,
    content: 'Page 1\nMom Dad Sister',
    pdfOcrStatus: 'completed',
    pdfOcrPages: [],
  }], {
    modelId: 'anthropic/claude-3.7-sonnet',
  });
  assert.equal(Array.isArray(content), false);
  assert.equal(content.includes('Attached PDF OCR text: scan.pdf'), true);
  assert.equal(content.includes('Mom Dad Sister'), true);
});

test('Images are excluded for models marked text-only', () => {
  const content = buildAttachmentContentForModel('Explain this image.', [imageAttachment], {
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    modelCatalog: {
      'meta-llama/llama-3.3-70b-instruct': {
        modalities: ['text'],
      },
    },
    capabilityRegistry: {
      providers: {
        openrouter: {
          capabilities: {
            imageInput: true,
          },
        },
      },
    },
  });
  assert.equal(typeof content, 'string');
  assert.equal(content.includes('Attachments not sent to this model'), true);
  assert.equal(content.includes('diagram.png'), true);
});

test('Images with OCR text fall back to plaintext for text-only models', () => {
  const content = buildAttachmentContentForModel('Explain this screenshot.', [{
    ...imageAttachment,
    content: 'Button: Submit\nStatus: Success',
  }], {
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    modelCatalog: {
      'meta-llama/llama-3.3-70b-instruct': {
        modalities: ['text'],
      },
    },
    capabilityRegistry: {
      providers: {
        openrouter: {
          capabilities: {
            imageInput: true,
          },
        },
      },
    },
  });
  assert.equal(typeof content, 'string');
  assert.equal(content.includes('Attached image OCR text: diagram.png'), true);
  assert.equal(content.includes('Button: Submit'), true);
});

test('Routing overview reports OCR fallback for images with extracted text', () => {
  const routing = buildAttachmentRoutingOverview({
    attachments: [{
      ...imageAttachment,
      content: 'Settings panel\nDark mode',
    }],
    models: ['meta-llama/llama-3.3-70b-instruct'],
    modelCatalog: {
      'meta-llama/llama-3.3-70b-instruct': {
        modalities: ['text'],
      },
    },
    capabilityRegistry: {
      providers: {
        openrouter: {
          capabilities: {
            imageInput: true,
          },
        },
      },
    },
  })[0];
  assert.deepEqual(routing.fallbackModels, ['meta-llama/llama-3.3-70b-instruct']);
  assert.equal(routing.primaryLabel, 'OCR fallback');
});

test('Routing overview reports mixed native and fallback handling', () => {
  const routing = buildAttachmentRoutingOverview({
    attachments: [{
      ...imageAttachment,
      content: 'Diagram label text',
    }],
    models: ['anthropic/claude-3.7-sonnet', 'meta-llama/llama-3.3-70b-instruct'],
    modelCatalog: {
      'meta-llama/llama-3.3-70b-instruct': {
        modalities: ['text'],
      },
    },
  })[0];
  assert.deepEqual(routing.nativeModels, ['anthropic/claude-3.7-sonnet']);
  assert.deepEqual(routing.fallbackModels, ['meta-llama/llama-3.3-70b-instruct']);
  assert.equal(routing.primaryLabel, 'Mixed routing');
});

test('Plaintext attachment builder includes OCR text for image fallbacks', () => {
  const content = buildAttachmentTextContent('Summarize the screenshot.', [{
    ...imageAttachment,
    content: 'Error: Missing API key',
  }]);
  assert.equal(content.includes('Attached image OCR text: diagram.png'), true);
  assert.equal(content.includes('Missing API key'), true);
});

test('Large text fallbacks are placed before the variable user request for implicit caching', () => {
  const content = buildAttachmentContentForModel('Find the main risk.', [{
    ...pdfAttachment,
    category: 'text',
    dataUrl: '',
    content: 'Risk register row\n'.repeat(400),
  }], {
    modelId: 'openai:gpt-5.2',
  });
  assert.equal(typeof content, 'string');
  assert.equal(content.indexOf('Reusable reference material') < content.indexOf('User request'), true);
  assert.equal(content.includes('Find the main risk.'), true);
});

test('OpenRouter Gemini receives explicit cache_control on large reusable text blocks', () => {
  const content = buildAttachmentContentForModel('List the assumptions.', [{
    ...pdfAttachment,
    category: 'text',
    dataUrl: '',
    content: 'Assumption catalog row\n'.repeat(400),
  }], {
    modelId: 'google/gemini-2.5-pro',
  });
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, 'text');
  assert.deepEqual(content[0].cache_control, { type: 'ephemeral' });
  assert.equal(content[1].text.includes('User request'), true);
});

test('Direct Claude receives explicit cache_control on large reusable text blocks', () => {
  const content = buildAttachmentContentForModel('List the assumptions.', [{
    ...pdfAttachment,
    category: 'text',
    dataUrl: '',
    content: 'Assumption catalog row\n'.repeat(400),
  }], {
    modelId: 'anthropic:claude-sonnet-4-5',
  });
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, 'text');
  assert.deepEqual(content[0].cache_control, { type: 'ephemeral' });
  assert.equal(content[1].text.includes('User request'), true);
});
