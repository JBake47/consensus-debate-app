import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
    assert.equal(typeof data.limits.maxAttachments, 'number');
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
});

// eslint-disable-next-line no-console
console.log('Multimodal API integration tests completed.');
