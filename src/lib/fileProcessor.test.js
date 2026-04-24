import assert from 'node:assert/strict';
import {
  getPdfTextExtractionBudget,
  hasUsefulPdfText,
  getImageResizeDimensions,
  MAX_NATIVE_IMAGE_DIMENSION,
  PDF_TEXT_MAX_CHARS,
  PDF_TEXT_MAX_PAGES,
  processFile,
} from './fileProcessor.js';

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

await test('safe PDF fallback marks PDFs unsafe for native parser replay', async () => {
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
  assert.equal(attachment.pdfRequiresOcr, true);
  assert.equal(attachment.pdfOcrStatus, 'unavailable');
  assert.equal(Array.isArray(attachment.pdfOcrPages), true);
  assert.equal(attachment.previewMeta.hasTextLayer, false);
  assert.equal(attachment.previewMeta.needsOcr, true);
});

await test('hasUsefulPdfText ignores page headers and whitespace', async () => {
  assert.equal(hasUsefulPdfText('--- Page 1 ---\n\n   '), false);
  assert.equal(hasUsefulPdfText('--- Page 1 ---\nReadable text'), true);
});

await test('PDF text extraction budget caps page and character work', async () => {
  const smallBudget = getPdfTextExtractionBudget(5);
  assert.equal(smallBudget.pageLimit, 5);
  assert.equal(smallBudget.pagesTruncated, false);
  assert.equal(smallBudget.charLimit, PDF_TEXT_MAX_CHARS);

  const largeBudget = getPdfTextExtractionBudget(PDF_TEXT_MAX_PAGES + 50);
  assert.equal(largeBudget.pageLimit, PDF_TEXT_MAX_PAGES);
  assert.equal(largeBudget.pagesTruncated, true);
});

await test('image resize dimensions cap portrait screenshots at provider limit', async () => {
  const dimensions = getImageResizeDimensions(551, 11024);
  assert.equal(dimensions.resized, true);
  assert.equal(dimensions.height, MAX_NATIVE_IMAGE_DIMENSION);
  assert.equal(dimensions.width < 551, true);
});

await test('image resize dimensions preserve images within provider limit', async () => {
  const dimensions = getImageResizeDimensions(1200, 800);
  assert.deepEqual(dimensions, {
    width: 1200,
    height: 800,
    resized: false,
    scale: 1,
  });
});
