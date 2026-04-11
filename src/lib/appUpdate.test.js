import assert from 'node:assert/strict';
import {
  fetchAppUpdateStatus,
  requestAppRestart,
  waitForAppRestart,
} from './appUpdate.js';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

function textResponse(body, status = 404) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      throw new Error('Not JSON');
    },
    async text() {
      return String(body || '');
    },
  };
}

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

function withMockFetch(mockFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

await runTest('fetchAppUpdateStatus uses the legacy GET route for non-refresh checks', async () => {
  const calls = [];
  await withMockFetch(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    return jsonResponse({ updateAvailable: false });
  }, async () => {
    const result = await fetchAppUpdateStatus({ refresh: false });
    assert.equal(result.updateAvailable, false);
  });
  assert.deepEqual(calls, [
    { url: '/api/update/status', method: 'GET' },
  ]);
});

await runTest('fetchAppUpdateStatus falls back to the legacy refresh GET when POST is unavailable', async () => {
  const calls = [];
  await withMockFetch(async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      headers: options.headers || null,
    });
    if (url === '/api/update/status' && options.method === 'POST') {
      return textResponse('Not found', 404);
    }
    if (url === '/api/update/status?refresh=1') {
      return jsonResponse({ updateAvailable: true, checkedAt: 'legacy' });
    }
    throw new Error(`Unexpected request: ${(options.method || 'GET')} ${url}`);
  }, async () => {
    const result = await fetchAppUpdateStatus({ refresh: true });
    assert.equal(result.updateAvailable, true);
    assert.equal(result.checkedAt, 'legacy');
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/update/status');
  assert.equal(calls[0].headers['x-consensus-updater'], '1');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, '/api/update/status?refresh=1');
});

await runTest('requestAppRestart posts to the restart endpoint with the updater marker', async () => {
  const calls = [];
  await withMockFetch(async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      headers: options.headers || null,
    });
    return jsonResponse({ restarting: true, pid: 1234 });
  }, async () => {
    const result = await requestAppRestart();
    assert.equal(result.restarting, true);
    assert.equal(result.pid, 1234);
  });

  assert.deepEqual(calls, [
    {
      url: '/api/update/restart',
      method: 'POST',
      headers: {
        'x-consensus-updater': '1',
      },
    },
  ]);
});

await runTest('waitForAppRestart waits for a new backend pid before returning', async () => {
  const calls = [];
  await withMockFetch(async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
    });

    if (calls.length === 1) {
      return jsonResponse({ ok: true, pid: 2001, startedAt: 'old-server' });
    }
    if (calls.length === 2) {
      return textResponse('Service unavailable', 503);
    }
    return jsonResponse({ ok: true, pid: 2002, startedAt: 'new-server' });
  }, async () => {
    const result = await waitForAppRestart({
      previousPid: 2001,
      previousStartedAt: 'old-server',
      timeoutMs: 100,
      pollIntervalMs: 0,
    });
    assert.equal(result.pid, 2002);
    assert.equal(result.startedAt, 'new-server');
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(calls.every((call) => call.url.startsWith('/api/health?_ts=')));
});

await runTest('waitForAppRestart also accepts a new server start time when pid is unchanged', async () => {
  await withMockFetch(async () => jsonResponse({ ok: true, pid: 2001, startedAt: 'new-server' }), async () => {
    const result = await waitForAppRestart({
      previousPid: 2001,
      previousStartedAt: 'old-server',
      timeoutMs: 100,
      pollIntervalMs: 0,
    });
    assert.equal(result.pid, 2001);
    assert.equal(result.startedAt, 'new-server');
  });
});
