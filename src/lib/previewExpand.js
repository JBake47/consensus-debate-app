const EXPAND_CLICK_IGNORE_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '.code-block',
  'pre',
  'code',
].join(', ');

function hasSelectionWithin(container) {
  if (
    typeof window === 'undefined' ||
    typeof window.getSelection !== 'function' ||
    !(container instanceof Element)
  ) {
    return false;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;

  return ancestor instanceof Node && container.contains(ancestor);
}

export function recordPreviewPointerDown(pointerRef, event) {
  if (!pointerRef) return;

  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    pointerRef.current = null;
    return;
  }

  pointerRef.current = {
    x: event.clientX,
    y: event.clientY,
  };
}

export function shouldExpandPreviewFromClick(event, pointerRef) {
  if (event.defaultPrevented || event.button !== 0) {
    return false;
  }

  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }

  const target = event.target;
  const container = event.currentTarget;
  const pointerStart = pointerRef?.current || null;

  if (pointerRef) {
    pointerRef.current = null;
  }

  if (!(target instanceof Element) || !(container instanceof Element)) {
    return false;
  }

  if (target.closest(EXPAND_CLICK_IGNORE_SELECTOR)) {
    return false;
  }

  if (hasSelectionWithin(container)) {
    return false;
  }

  if (pointerStart) {
    const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    if (distance > 6) {
      return false;
    }
  }

  return true;
}
