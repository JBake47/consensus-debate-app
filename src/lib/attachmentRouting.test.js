import assert from 'node:assert/strict';
import {
  buildAttachmentContentForModel,
  buildAttachmentRoutingOverview,
} from './attachmentRouting.js';

const pdfAttachment = {
  name: 'brief.pdf',
  size: 2048,
  type: 'application/pdf',
  category: 'pdf',
  dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
  content: '--- Page 1 ---\nExample PDF text',
  processingStatus: 'ready',
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

test('OpenRouter-routed PDFs become native file parts', () => {
  const content = buildAttachmentContentForModel('Review the attached brief.', [pdfAttachment], {
    modelId: 'anthropic/claude-3.7-sonnet',
  });
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'file');
  assert.equal(content[1].file.filename, 'brief.pdf');
  assert.equal(content[1].file.file_data, pdfAttachment.dataUrl);
});

test('Direct-provider PDFs fall back to extracted text', () => {
  const content = buildAttachmentContentForModel('Review the attached brief.', [pdfAttachment], {
    modelId: 'anthropic:claude-sonnet-4-5',
  });
  assert.equal(typeof content, 'string');
  assert.equal(content.includes('Attached PDF fallback text: brief.pdf'), true);
  assert.equal(content.includes('Example PDF text'), true);
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

test('Routing overview reports mixed native and fallback handling', () => {
  const routing = buildAttachmentRoutingOverview({
    attachments: [pdfAttachment],
    models: ['anthropic/claude-3.7-sonnet', 'openai:gpt-4.1-mini'],
  })[0];
  assert.deepEqual(routing.nativeModels, ['anthropic/claude-3.7-sonnet']);
  assert.deepEqual(routing.fallbackModels, ['openai:gpt-4.1-mini']);
  assert.equal(routing.primaryLabel, 'Mixed routing');
});
