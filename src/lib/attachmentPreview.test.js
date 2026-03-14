import assert from 'node:assert/strict';
import {
  getAttachmentPreviewFallbackMessage,
  getAttachmentPreviewPlan,
  getAttachmentPreviewModeLabel,
  getAttachmentTextPreview,
  getAttachmentTypeLabel,
} from './attachmentPreview.js';

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

test('PDF preview defaults to text and keeps pages fallback available for local uploads', () => {
  const plan = getAttachmentPreviewPlan({
    name: 'brief.pdf',
    type: 'application/pdf',
    category: 'pdf',
    dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
    content: 'Extracted PDF text',
    processingStatus: 'ready',
  });

  assert.equal(plan.kind, 'pdf');
  assert.deepEqual(plan.modes, ['text', 'pdfjs']);
  assert.equal(plan.initialMode, 'text');
  assert.equal(plan.pdfFallbackMode, 'text');
});

test('Sourceless PDFs fall back directly to extracted text', () => {
  const plan = getAttachmentPreviewPlan({
    name: 'scan.pdf',
    type: 'application/pdf',
    category: 'pdf',
    content: 'OCR text',
    processingStatus: 'ready',
  });

  assert.equal(plan.kind, 'pdf');
  assert.deepEqual(plan.modes, ['text']);
  assert.equal(plan.initialMode, 'text');
});

test('Local PDFs without extracted text default to details instead of loading a heavy renderer', () => {
  const plan = getAttachmentPreviewPlan({
    name: 'scan.pdf',
    type: 'application/pdf',
    category: 'pdf',
    dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
    processingStatus: 'ready',
  });

  assert.deepEqual(plan.modes, ['details', 'pdfjs']);
  assert.equal(plan.initialMode, 'details');
});

test('Remote PDFs without extracted text default to browser preview', () => {
  const plan = getAttachmentPreviewPlan({
    name: 'report.pdf',
    type: 'application/pdf',
    category: 'pdf',
    downloadUrl: '/api/artifacts/report.pdf?token=abc',
    processingStatus: 'ready',
  });

  assert.deepEqual(plan.modes, ['browser', 'pdfjs']);
  assert.equal(plan.initialMode, 'browser');
});

test('Audio and video files get native media preview modes', () => {
  const videoPlan = getAttachmentPreviewPlan({
    name: 'demo.mp4',
    type: 'video/mp4',
    category: 'binary',
    downloadUrl: '/media/demo.mp4',
    processingStatus: 'ready',
  });
  const audioPlan = getAttachmentPreviewPlan({
    name: 'voice.mp3',
    type: 'audio/mpeg',
    category: 'binary',
    downloadUrl: '/media/voice.mp3',
    processingStatus: 'ready',
  });

  assert.equal(videoPlan.initialMode, 'video');
  assert.equal(audioPlan.initialMode, 'audio');
  assert.equal(getAttachmentPreviewModeLabel(videoPlan.initialMode), 'Video');
  assert.equal(getAttachmentPreviewModeLabel(audioPlan.initialMode), 'Audio');
});

test('Binary attachments fall back to details instead of a broken inline preview', () => {
  const attachment = {
    name: 'archive.zip',
    type: 'application/zip',
    category: 'binary',
    downloadUrl: '/files/archive.zip',
    processingStatus: 'ready',
  };

  const plan = getAttachmentPreviewPlan(attachment);
  assert.equal(plan.kind, 'binary');
  assert.deepEqual(plan.modes, ['details']);
  assert.equal(getAttachmentPreviewFallbackMessage(attachment, plan), 'This file type cannot be previewed inline. Use download to inspect the original file.');
});

test('Failed attachments expose an explicit failure message', () => {
  const attachment = {
    name: 'broken.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'error',
    error: 'Server extraction failed',
    processingStatus: 'error',
  };

  const plan = getAttachmentPreviewPlan(attachment);
  assert.equal(plan.kind, 'error');
  assert.equal(getAttachmentPreviewFallbackMessage(attachment, plan), 'Server extraction failed');
  assert.equal(getAttachmentTypeLabel(attachment), 'Failed attachment');
});

test('Large text previews are truncated before rendering', () => {
  const preview = getAttachmentTextPreview('A'.repeat(150_000), 10_000);
  assert.equal(preview.truncated, true);
  assert.equal(preview.shownChars, 10_000);
  assert.equal(preview.totalChars, 150_000);
  assert.equal(preview.text.endsWith('... (preview truncated)'), true);
});
