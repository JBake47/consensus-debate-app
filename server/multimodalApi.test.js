import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { Document as DocxDocument, Packer as DocxPacker, Paragraph } from 'docx';

function randomPort() {
  return 39000 + Math.floor(Math.random() * 1500);
}

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      // eslint-disable-next-line no-console
      console.log(`PASS: ${name}`);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`FAIL: ${name}`);
      throw error;
    });
}

function spawnServer(port, envOverrides = {}) {
  let logs = '';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ALLOW_REMOTE_API: 'true',
      MULTIMODAL_MAX_JOB_POLL_MS: '60000',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    logs += String(chunk || '');
  });
  child.stderr.on('data', (chunk) => {
    logs += String(chunk || '');
  });
  return { child, getLogs: () => logs };
}

async function waitForServer(baseUrl, getLogs) {
  const timeoutMs = 12_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await delay(200);
  }
  throw new Error(`Server failed to start in time. Logs:\n${getLogs()}`);
}

async function pollJob(baseUrl, jobId) {
  const timeoutMs = 65_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${baseUrl}/api/multimodal/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(response.ok, true, 'Job poll request should succeed');
    const data = await response.json();
    if (data.status === 'completed') return data;
    if (data.status === 'failed') {
      throw new Error(data.error || 'Job failed without error message');
    }
    await delay(300);
  }
  throw new Error('Timed out waiting for multimodal job completion');
}

async function withServer(envOverrides, fn) {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, getLogs } = spawnServer(port, envOverrides);

  try {
    await waitForServer(baseUrl, getLogs);
    await fn({ baseUrl, getLogs });
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
  }
}

async function stopServer(child) {
  child.kill();
  await once(child, 'exit').catch(() => {});
}

await withServer({}, async ({ baseUrl }) => {
  await runTest('GET /api/capabilities returns multimodal registry + limits', async () => {
    const response = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(response.ok, true);
    const data = await response.json();
    assert.equal(typeof data, 'object');
    assert.equal(typeof data.capabilityRegistry, 'object');
    assert.equal(typeof data.providerHealth, 'object');
    assert.equal(typeof data.limits, 'object');
    assert.equal(typeof data.capabilityRegistry.routingVersion, 'string');
    assert.equal(typeof data.capabilityRegistry.providers?.openrouter?.capabilities?.webSearchNative, 'boolean');
    assert.equal(typeof data.limits.maxAttachments, 'number');
    assert.equal(typeof data.limits.maxJobs, 'number');
    assert.equal(data.limits.pdfOcrMaxPages, 8);
    assert.equal(data.limits.pdfOcrPageMaxBytes, 3 * 1024 * 1024);
    assert.equal(data.limits.pdfOcrTotalMaxBytes, 14 * 1024 * 1024);
  });

  await runTest('POST /api/files/extract-text extracts Word and Excel text server-side', async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Budget');
    worksheet.addRow(['Item', 'Amount']);
    worksheet.addRow(['Servers', 42]);
    const excelBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const excelResponse = await fetch(`${baseUrl}/api/files/extract-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('budget.xlsx'),
      },
      body: excelBuffer,
    });
    assert.equal(excelResponse.status, 200);
    const excelData = await excelResponse.json();
    assert.equal(excelData.category, 'excel');
    assert.equal(excelData.content.includes('--- Sheet: Budget ---'), true);
    assert.equal(excelData.content.includes('Servers,42'), true);

    const doc = new DocxDocument({
      sections: [{ children: [new Paragraph('Hello from the server-side Word extractor.')] }],
    });
    const wordBuffer = await DocxPacker.toBuffer(doc);

    const wordResponse = await fetch(`${baseUrl}/api/files/extract-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('notes.docx'),
      },
      body: wordBuffer,
    });
    assert.equal(wordResponse.status, 200);
    const wordData = await wordResponse.json();
    assert.equal(wordData.category, 'word');
    assert.equal(wordData.content.includes('Hello from the server-side Word extractor.'), true);
  });

  await runTest('async multimodal job completes and artifact signed url is downloadable', async () => {
    const payload = {
      prompt: 'Generate a short PDF handout about electric vehicles.',
      selectedModels: [],
      synthesizerModel: '',
      attachments: [],
      providerStatus: {},
    };

    const createResponse = await fetch(`${baseUrl}/api/multimodal/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(typeof created.jobId, 'string');

    const duplicateResponse = await fetch(`${baseUrl}/api/multimodal/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(duplicateResponse.status, 202);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.jobId, created.jobId, 'Identical multimodal jobs should be reused');

    const completed = await pollJob(baseUrl, created.jobId);
    const result = completed.result || {};
    assert.equal(Array.isArray(result.generatedAttachments), true);
    assert.equal(result.generatedAttachments.length > 0, true);

    const pdfAttachment = result.generatedAttachments.find((item) => item.generatedFormat === 'pdf');
    assert.equal(Boolean(pdfAttachment), true, 'Expected generated PDF attachment');
    assert.equal(typeof pdfAttachment.downloadUrl, 'string');
    assert.equal(pdfAttachment.downloadUrl.startsWith('/api/artifacts/'), true);

    const artifactResponse = await fetch(`${baseUrl}${pdfAttachment.downloadUrl}`);
    assert.equal(artifactResponse.ok, true);
    const body = Buffer.from(await artifactResponse.arrayBuffer());
    assert.equal(body.length > 0, true);
    assert.equal(artifactResponse.headers.get('content-type')?.includes('application/pdf'), true);
  });

  await runTest('async multimodal job reports blocked attachments while continuing safely', async () => {
    const executableBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00]).toString('base64');
    const createResponse = await fetch(`${baseUrl}/api/multimodal/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Generate a short PDF handout and consider the attachment if safe.',
        selectedModels: [],
        synthesizerModel: '',
        attachments: [{
          name: 'blocked.exe',
          category: 'binary',
          type: 'application/octet-stream',
          size: 4,
          dataUrl: `data:application/octet-stream;base64,${executableBytes}`,
        }],
        providerStatus: {},
      }),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    const completed = await pollJob(baseUrl, created.jobId);
    const result = completed.result || {};
    assert.equal(Array.isArray(result.rejectedAttachments), true);
    assert.equal(result.rejectedAttachments.length, 1);
    assert.equal(result.rejectedAttachments[0].name, 'blocked.exe');
    assert.equal(String(result.promptAugmentation || '').includes('Blocked attachments for security'), true);
    assert.equal((result.generatedAttachments || []).some((item) => item.generatedFormat === 'pdf'), true);
  });
});

await runTest('artifact signed urls survive a local server restart until expiry', async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'consensus-artifacts-'));
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ARTIFACT_STORE_DIR: artifactDir };
  let downloadUrl = '';

  try {
    const firstServer = spawnServer(port, env);
    try {
      await waitForServer(baseUrl, firstServer.getLogs);
      const createResponse = await fetch(`${baseUrl}/api/multimodal/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Generate a brief PDF restart durability check.',
          selectedModels: [],
          synthesizerModel: '',
          attachments: [],
          providerStatus: {},
        }),
      });
      assert.equal(createResponse.status, 202);
      const created = await createResponse.json();
      const completed = await pollJob(baseUrl, created.jobId);
      const pdfAttachment = (completed.result?.generatedAttachments || [])
        .find((item) => item.generatedFormat === 'pdf');
      assert.equal(Boolean(pdfAttachment?.downloadUrl), true);
      downloadUrl = pdfAttachment.downloadUrl;
      const initialDownload = await fetch(`${baseUrl}${downloadUrl}`);
      assert.equal(initialDownload.ok, true);
    } finally {
      await stopServer(firstServer.child);
    }

    const secondServer = spawnServer(port, env);
    try {
      await waitForServer(baseUrl, secondServer.getLogs);
      const restartedDownload = await fetch(`${baseUrl}${downloadUrl}`);
      assert.equal(restartedDownload.ok, true);
      assert.equal(restartedDownload.headers.get('content-type')?.includes('application/pdf'), true);
    } finally {
      await stopServer(secondServer.child);
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

await withServer({
  MULTIMODAL_MAX_JOBS: '1',
}, async ({ baseUrl }) => {
  await runTest('async multimodal queue caps unique retained jobs while still reusing duplicates', async () => {
    const payload = {
      prompt: 'Plain local multimodal queue cap check alpha.',
      selectedModels: [],
      synthesizerModel: '',
      attachments: [],
      providerStatus: {},
    };

    const createResponse = await fetch(`${baseUrl}/api/multimodal/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(typeof created.jobId, 'string');

    const duplicateResponse = await fetch(`${baseUrl}/api/multimodal/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(duplicateResponse.status, 202);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.jobId, created.jobId);

    const uniqueResponse = await fetch(`${baseUrl}/api/multimodal/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        prompt: 'Plain local multimodal queue cap check beta.',
      }),
    });
    assert.equal(uniqueResponse.status, 429);
    const rejected = await uniqueResponse.json();
    assert.equal(String(rejected.error || '').includes('queue is full'), true);

    const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(capabilitiesResponse.ok, true);
    const capabilities = await capabilitiesResponse.json();
    assert.equal(capabilities.limits.maxJobs, 1);
  });
});

await withServer({
  API_RATE_LIMIT_MAX_REQUESTS: '1',
}, async ({ baseUrl }) => {
  await runTest('multimodal job status polling is not charged as expensive API work', async () => {
    const firstPoll = await fetch(`${baseUrl}/api/multimodal/jobs/not-found`);
    assert.equal(firstPoll.status, 404);

    const secondPoll = await fetch(`${baseUrl}/api/multimodal/jobs/not-found`);
    assert.equal(secondPoll.status, 404);
  });
});

await withServer({
  PDF_OCR_MAX_PAGES: '999',
  PDF_OCR_PAGE_MAX_BYTES: 'not-a-number',
  PDF_OCR_TOTAL_MAX_BYTES: '1',
}, async ({ baseUrl }) => {
  await runTest('PDF OCR limits fall back and clamp unsafe environment values', async () => {
    const response = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(response.ok, true);
    const data = await response.json();
    assert.equal(data.limits.pdfOcrMaxPages, 16);
    assert.equal(data.limits.pdfOcrPageMaxBytes, 3 * 1024 * 1024);
    assert.equal(data.limits.pdfOcrTotalMaxBytes, 128 * 1024);
  });
});

await withServer({
  ALLOW_REMOTE_API: 'false',
  TRUST_PROXY: 'true',
  SERVER_AUTH_TOKEN: 'server-test-token',
}, async ({ baseUrl }) => {
  await runTest('localhost-only API mode blocks spoofed forwarded IPs but still accepts token auth', async () => {
    const localResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(localResponse.status, 200);

    const proxiedRemoteResponse = await fetch(`${baseUrl}/api/health`, {
      headers: {
        'X-Forwarded-For': '203.0.113.10',
      },
    });
    assert.equal(proxiedRemoteResponse.status, 403);

    const spoofedLoopbackResponse = await fetch(`${baseUrl}/api/health`, {
      headers: {
        'X-Forwarded-For': '127.0.0.1, 203.0.113.10',
      },
    });
    assert.equal(spoofedLoopbackResponse.status, 403);

    const tokenResponse = await fetch(`${baseUrl}/api/health`, {
      headers: {
        'X-Forwarded-For': '203.0.113.10',
        'x-server-auth-token': 'server-test-token',
      },
    });
    assert.equal(tokenResponse.status, 200);
  });

  await runTest('updater mutations require the local UI marker or the server token', async () => {
    const bareStatusResponse = await fetch(`${baseUrl}/api/update/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh: false }),
    });
    assert.equal(bareStatusResponse.status, 403);

    const remoteOriginStatusResponse = await fetch(`${baseUrl}/api/update/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'x-consensus-updater': '1',
      },
      body: JSON.stringify({ refresh: false }),
    });
    assert.equal(remoteOriginStatusResponse.status, 403);

    const localUiStatusWithoutOrigin = await fetch(`${baseUrl}/api/update/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-consensus-updater': '1',
      },
      body: JSON.stringify({ refresh: false }),
    });
    assert.equal(localUiStatusWithoutOrigin.status, 200);

    const localUiStatusResponse = await fetch(`${baseUrl}/api/update/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5173',
        'x-consensus-updater': '1',
      },
      body: JSON.stringify({ refresh: false }),
    });
    assert.equal(localUiStatusResponse.status, 200);

    const tokenStatusResponse = await fetch(`${baseUrl}/api/update/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-server-auth-token': 'server-test-token',
      },
      body: JSON.stringify({ refresh: false }),
    });
    assert.equal(tokenStatusResponse.status, 200);

    const bareApplyResponse = await fetch(`${baseUrl}/api/update/apply`, {
      method: 'POST',
    });
    assert.equal(bareApplyResponse.status, 403);

    const bareRestartResponse = await fetch(`${baseUrl}/api/update/restart`, {
      method: 'POST',
    });
    assert.equal(bareRestartResponse.status, 403);
  });
});

await withServer({
  ALLOW_REMOTE_API: 'true',
  TRUST_PROXY: 'true',
  SERVER_AUTH_TOKEN: 'server-test-token',
}, async ({ baseUrl }) => {
  await runTest('remote API mode still requires server token for non-loopback clients', async () => {
    const localResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(localResponse.status, 200);

    const remoteWithoutToken = await fetch(`${baseUrl}/api/health`, {
      headers: {
        'X-Forwarded-For': '203.0.113.20',
      },
    });
    assert.equal(remoteWithoutToken.status, 401);
    const remoteBody = await remoteWithoutToken.json();
    assert.equal(remoteBody.code, 'remote_api_auth_required');

    const remoteWithToken = await fetch(`${baseUrl}/api/health`, {
      headers: {
        'X-Forwarded-For': '203.0.113.20',
        'x-server-auth-token': 'server-test-token',
      },
    });
    assert.equal(remoteWithToken.status, 200);
  });
});

// eslint-disable-next-line no-console
console.log('Multimodal API integration tests completed.');
