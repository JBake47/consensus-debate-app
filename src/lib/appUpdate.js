import { OpenRouterError } from './openrouter';

const APP_UPDATE_STATUS_URL = '/api/update/status';
const APP_UPDATE_APPLY_URL = '/api/update/apply';

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
  const params = new URLSearchParams();
  if (refresh) {
    params.set('refresh', '1');
  }

  const url = params.size > 0
    ? `${APP_UPDATE_STATUS_URL}?${params.toString()}`
    : APP_UPDATE_STATUS_URL;

  const response = await fetch(url);
  return parseResponse(response, 'Failed to fetch app update status.');
}

export async function applyAppUpdate() {
  const response = await fetch(APP_UPDATE_APPLY_URL, {
    method: 'POST',
  });
  return parseResponse(response, 'Failed to apply app update.');
}
