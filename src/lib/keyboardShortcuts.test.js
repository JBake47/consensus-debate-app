import assert from 'node:assert/strict';
import { isTypingShortcutTarget, matchesShortcut } from './keyboardShortcuts.js';

async function runTest(name, fn) {
  try {
    await fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

await runTest('matchesShortcut recognizes Alt shortcuts with exact modifiers', async () => {
  assert.equal(matchesShortcut({
    key: 'n',
    altKey: true,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
  }, 'Alt+N'), true);

  assert.equal(matchesShortcut({
    key: 'n',
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
  }, 'Alt+N'), false);
});

await runTest('matchesShortcut recognizes combined modifier shortcuts', async () => {
  assert.equal(matchesShortcut({
    key: 'r',
    altKey: true,
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
  }, 'Alt+Shift+R'), true);

  assert.equal(matchesShortcut({
    key: 'r',
    altKey: true,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
  }, 'Alt+Shift+R'), false);
});

await runTest('isTypingShortcutTarget ignores input-like elements', async () => {
  const textArea = {
    tagName: 'TEXTAREA',
    isContentEditable: false,
  };
  const plainDiv = {
    tagName: 'DIV',
    isContentEditable: false,
  };

  const originalHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class HTMLElement {};

  try {
    Object.setPrototypeOf(textArea, globalThis.HTMLElement.prototype);
    Object.setPrototypeOf(plainDiv, globalThis.HTMLElement.prototype);
    assert.equal(isTypingShortcutTarget(textArea), true);
    assert.equal(isTypingShortcutTarget(plainDiv), false);
  } finally {
    globalThis.HTMLElement = originalHTMLElement;
  }
});
