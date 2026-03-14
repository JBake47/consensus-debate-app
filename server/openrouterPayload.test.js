import assert from 'node:assert/strict';
import { buildOpenRouterPlugins, hasOpenRouterFileParts } from './openrouterPayload.js';

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

test('OpenRouter plugin builder adds web and file parser plugins when needed', () => {
  const plugins = buildOpenRouterPlugins({
    nativeWebSearch: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this file.' },
          { type: 'file', file: { filename: 'brief.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK' } },
        ],
      },
    ],
    webPluginId: 'web',
    filePluginId: 'file-parser',
    pdfEngine: 'mistral-ocr',
  });
  assert.deepEqual(plugins, [
    { id: 'web' },
    { id: 'file-parser', pdf: { engine: 'mistral-ocr' } },
  ]);
});

test('File part detector ignores plain text messages', () => {
  assert.equal(hasOpenRouterFileParts([{ role: 'user', content: 'Hello' }]), false);
  assert.equal(hasOpenRouterFileParts([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]), false);
});
