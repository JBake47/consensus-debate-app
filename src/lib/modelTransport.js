export function getTransportProviderId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw.startsWith('openrouter/')) return 'openrouter';
  if (raw.includes(':')) {
    const prefix = raw.split(':')[0];
    if (prefix === 'google') return 'gemini';
    return prefix;
  }
  return 'openrouter';
}

export function usesOpenRouterTransport(modelId) {
  return getTransportProviderId(modelId) === 'openrouter';
}
