import { OpenRouterError } from './openrouter.js';

const APP_UPDATE_STATUS_URL = '/api/update/status';
const APP_UPDATE_APPLY_URL = '/api/update/apply';
const APP_UPDATE_REQUEST_HEADER = 'x-consensus-updater';
const LEGACY_STATUS_FALLBACK_STATUSES = new Set([404, 405, 501]);

function buildUpdateRequestHeaders(includeJson = false) {
  const headers = {
    [APP_UPDATE_REQUEST_HEADER]: '1',
  };
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

async function parseResponse(response, fallbackMessage) {
  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new OpenRouterError(
      payload?.error || fallbackMessage,
      response.status,
      payload?.code || null,
    );
  }

  return payload;
}

function buildLegacyStatusUrl({ refresh = false } = {}) {
  const params = new URLSearchParams();
  if (refresh) {
    params.set('refresh', '1');
  }
  return params.size > 0
    ? `${APP_UPDATE_STATUS_URL}?${params.toString()}`
    : APP_UPDATE_STATUS_URL;
}

async function fetchLegacyAppUpdateStatus({ refresh = false } = {}) {
  const response = await fetch(buildLegacyStatusUrl({ refresh }));
  return parseResponse(response, 'Failed to fetch app update status.');
}

export async function fetchAppUpdateStatus({ refresh = false } = {}) {
  if (!refresh) {
    return fetchLegacyAppUpdateStatus({ refresh: false });
  }

  const response = await fetch(APP_UPDATE_STATUS_URL, {
      method: 'POST',
      headers: buildUpdateRequestHeaders(true),
      body: JSON.stringify({ refresh: true }),
    });
  if (!response.ok && LEGACY_STATUS_FALLBACK_STATUSES.has(response.status)) {
    return fetchLegacyAppUpdateStatus({ refresh: true });
  }
  return parseResponse(response, 'Failed to fetch app update status.');
}

export async function applyAppUpdate() {
  const response = await fetch(APP_UPDATE_APPLY_URL, {
    method: 'POST',
    headers: buildUpdateRequestHeaders(),
  });
  return parseResponse(response, 'Failed to apply app update.');
}
