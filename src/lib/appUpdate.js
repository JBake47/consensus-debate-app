import { OpenRouterError } from './openrouter';

const APP_UPDATE_STATUS_URL = '/api/update/status';
const APP_UPDATE_APPLY_URL = '/api/update/apply';
const APP_UPDATE_REQUEST_HEADER = 'x-consensus-updater';

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

export async function fetchAppUpdateStatus({ refresh = false } = {}) {
  const response = refresh
    ? await fetch(APP_UPDATE_STATUS_URL, {
      method: 'POST',
      headers: buildUpdateRequestHeaders(true),
      body: JSON.stringify({ refresh: true }),
    })
    : await fetch(APP_UPDATE_STATUS_URL);
  return parseResponse(response, 'Failed to fetch app update status.');
}

export async function applyAppUpdate() {
  const response = await fetch(APP_UPDATE_APPLY_URL, {
    method: 'POST',
    headers: buildUpdateRequestHeaders(),
  });
  return parseResponse(response, 'Failed to apply app update.');
}
