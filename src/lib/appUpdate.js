import { OpenRouterError } from './openrouter.js';

const APP_UPDATE_STATUS_URL = '/api/update/status';
const APP_UPDATE_APPLY_URL = '/api/update/apply';
const APP_UPDATE_RESTART_URL = '/api/update/restart';
const APP_HEALTH_URL = '/api/health';
const APP_UPDATE_REQUEST_HEADER = 'x-consensus-updater';
const LEGACY_STATUS_FALLBACK_STATUSES = new Set([404, 405, 501]);
const DEFAULT_APP_RESTART_TIMEOUT_MS = 30000;
const DEFAULT_APP_RESTART_POLL_INTERVAL_MS = 750;

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

export async function requestAppRestart() {
  const response = await fetch(APP_UPDATE_RESTART_URL, {
    method: 'POST',
    headers: buildUpdateRequestHeaders(),
  });
  return parseResponse(response, 'Failed to restart the app.');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchAppHealth() {
  try {
    const separator = APP_HEALTH_URL.includes('?') ? '&' : '?';
    const response = await fetch(`${APP_HEALTH_URL}${separator}_ts=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
      },
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

export async function waitForAppRestart({
  previousPid = null,
  previousStartedAt = null,
  timeoutMs = DEFAULT_APP_RESTART_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_APP_RESTART_POLL_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

  while (Date.now() < deadline) {
    const health = await fetchAppHealth();
    const pidChanged = previousPid == null || health?.pid !== previousPid;
    const startTimeChanged = previousStartedAt == null || health?.startedAt !== previousStartedAt;
    if (health && (pidChanged || startTimeChanged)) {
      return health;
    }
    await sleep(Math.max(0, Number(pollIntervalMs) || 0));
  }

  throw new OpenRouterError(
    'The app did not come back online after the restart. Restart it manually.',
    504,
    'restart_timeout',
  );
}
