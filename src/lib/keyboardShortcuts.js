function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

export function isTypingShortcutTarget(target) {
  if (!target) return false;
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
}

export function matchesShortcut(event, shortcut) {
  const normalizedShortcut = String(shortcut || '').trim();
  if (!normalizedShortcut) return false;

  const parsed = {
    alt: false,
    shift: false,
    ctrlCmd: false,
    key: '',
  };

  for (const rawToken of normalizedShortcut.split('+')) {
    const token = normalizeToken(rawToken);
    if (!token) continue;
    if (token === 'alt' || token === 'option') {
      parsed.alt = true;
      continue;
    }
    if (token === 'shift') {
      parsed.shift = true;
      continue;
    }
    if (token === 'ctrl/cmd' || token === 'cmd/ctrl' || token === 'ctrlcmd' || token === 'mod') {
      parsed.ctrlCmd = true;
      continue;
    }
    parsed.key = token;
  }

  const eventKey = normalizeToken(event?.key);
  if (!parsed.key || eventKey !== parsed.key) {
    return false;
  }

  const hasCtrlCmd = Boolean(event?.metaKey || event?.ctrlKey);
  if (parsed.ctrlCmd !== hasCtrlCmd) {
    return false;
  }
  if (parsed.alt !== Boolean(event?.altKey)) {
    return false;
  }
  if (parsed.shift !== Boolean(event?.shiftKey)) {
    return false;
  }

  return true;
}
