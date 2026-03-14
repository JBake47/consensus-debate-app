import assert from 'node:assert/strict';
import { processFile } from './fileProcessor.js';

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      // eslint-disable-next-line no-console
      console.log(`PASS: ${name}`);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`FAIL: ${name}`);
      throw error;
    });
}

await test('safe PDF fallback avoids text extraction on the main thread', async () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  const file = {
    name: 'brief.pdf',
    size: pdfBytes.byteLength,
    type: 'application/pdf',
    arrayBuffer: async () => pdfBytes.buffer.slice(0),
  };

  const attachment = await processFile(file, { safePdfFallback: true });
  assert.equal(attachment.category, 'pdf');
  assert.equal(attachment.content, '');
  assert.equal(attachment.preview, 'binary');
  assert.equal(typeof attachment.dataUrl, 'string');
  assert.equal(attachment.dataUrl.startsWith('data:application/pdf;base64,'), true);
  assert.equal(attachment.inlineWarning.includes('skipped'), true);
});
