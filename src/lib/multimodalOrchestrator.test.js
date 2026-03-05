import assert from 'node:assert/strict';
import {
  orchestrateMultimodalTurn,
  shouldCallOrchestrator,
  normalizeGeneratedAttachment,
} from './multimodalOrchestrator.js';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
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

await runTest('shouldCallOrchestrator detects multimodal intents', async () => {
  assert.equal(shouldCallOrchestrator('Please summarize https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(shouldCallOrchestrator('Generate a PDF and an XLSX budget sheet.'), true);
  assert.equal(shouldCallOrchestrator('What is the weather in Boston?'), false);
});

await runTest('normalizeGeneratedAttachment keeps signed url metadata', async () => {
  const normalized = normalizeGeneratedAttachment({
    name: 'report.pdf',
    size: 1024,
    type: 'application/pdf',
    category: 'pdf',
    content: 'Summary',
    downloadUrl: '/api/artifacts/a?token=t',
    expiresAt: 1000,
    storageId: 'artifact_123',
    generatedFormat: 'pdf',
    provenance: { provider: 'openai' },
  });
  assert.equal(normalized.name, 'report.pdf');
  assert.equal(normalized.downloadUrl, '/api/artifacts/a?token=t');
  assert.equal(normalized.storageId, 'artifact_123');
  assert.equal(normalized.generated, true);
  assert.deepEqual(normalized.provenance, { provider: 'openai' });
});

await runTest('orchestrateMultimodalTurn bypasses orchestration when no trigger exists', async () => {
  await withMockFetch(async () => {
    throw new Error('fetch should not be called');
  }, async () => {
    const result = await orchestrateMultimodalTurn({
      prompt: 'No multimodal trigger in this sentence.',
      attachments: [{ name: 'notes.txt', category: 'text', content: 'Hello', size: 5 }],
    });
    assert.equal(result.prompt, 'No multimodal trigger in this sentence.');
    assert.equal(Array.isArray(result.attachments), true);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.routeInfo, null);
  });
});

await runTest('orchestrateMultimodalTurn consumes async job result', async () => {
  const calls = [];
  await withMockFetch(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === '/api/multimodal/jobs' && options.method === 'POST') {
      return jsonResponse({ jobId: 'mmjob_1', status: 'pending' }, true, 202);
    }
    if (url === '/api/multimodal/jobs/mmjob_1') {
      return jsonResponse({
        jobId: 'mmjob_1',
        status: 'completed',
        result: {
          handled: true,
          modelOverrides: ['gemini:gemini-2.5-flash'],
          promptAugmentation: 'Generated artifacts attached (1): brief.pdf',
          generatedAttachments: [{
            name: 'brief.pdf',
            size: 42,
            type: 'application/pdf',
            category: 'pdf',
            content: 'Summary',
            downloadUrl: '/api/artifacts/a?token=t',
            generatedFormat: 'pdf',
          }],
          youtubeUrls: ['https://youtu.be/demo'],
          routingDecisions: [{ type: 'youtube' }],
          rejectedAttachments: [{ name: 'bad.exe', reason: 'blocked' }],
          capabilityRegistry: { routingVersion: '2026-03-05' },
        },
      });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  }, async () => {
    const result = await orchestrateMultimodalTurn({
      prompt: 'Generate a pdf from these notes',
      attachments: [{ name: 'notes.md', category: 'text', content: '# Notes', size: 7 }],
      selectedModels: ['openai:gpt-4.1-mini'],
      synthesizerModel: 'openai:gpt-4.1-mini',
      providerStatus: { openai: true },
    });
    assert.equal(result.prompt.includes('Generated artifacts attached'), true);
    assert.equal(result.attachments.length, 2);
    assert.equal(result.attachments[1].downloadUrl, '/api/artifacts/a?token=t');
    assert.deepEqual(result.modelOverrides, ['gemini:gemini-2.5-flash']);
    assert.deepEqual(result.routeInfo.youtubeUrls, ['https://youtu.be/demo']);
    assert.equal(result.routeInfo.rejectedAttachments.length, 1);
    assert.equal(result.routeInfo.capabilityRegistry.routingVersion, '2026-03-05');
  });
  assert.equal(calls.length >= 2, true);
});

await runTest('orchestrateMultimodalTurn falls back to sync orchestration on async failure', async () => {
  const calls = [];
  await withMockFetch(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === '/api/multimodal/jobs' && options.method === 'POST') {
      return jsonResponse('queue unavailable', false, 503);
    }
    if (url === '/api/multimodal/orchestrate' && options.method === 'POST') {
      return jsonResponse({
        handled: true,
        modelOverrides: null,
        promptAugmentation: 'Fallback orchestration result',
        generatedAttachments: [],
        youtubeUrls: [],
        routingDecisions: [{ type: 'fallback' }],
      });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  }, async () => {
    const result = await orchestrateMultimodalTurn({
      prompt: 'Generate a PDF from this text',
      attachments: [],
    });
    assert.equal(result.prompt.includes('Fallback orchestration result'), true);
    assert.equal(result.routeInfo.handled, true);
  });
  assert.equal(calls.some((call) => call.url === '/api/multimodal/orchestrate'), true);
});

await runTest('orchestrateMultimodalTurn resumes a queued job when sync fallback returns 202', async () => {
  const calls = [];
  await withMockFetch(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === '/api/multimodal/jobs' && options.method === 'POST') {
      return jsonResponse('queue unavailable', false, 503);
    }
    if (url === '/api/multimodal/orchestrate' && options.method === 'POST') {
      return jsonResponse({ jobId: 'mmjob_reused', status: 'running' }, true, 202);
    }
    if (url === '/api/multimodal/jobs/mmjob_reused') {
      return jsonResponse({
        jobId: 'mmjob_reused',
        status: 'completed',
        result: {
          handled: true,
          promptAugmentation: 'Queued job finished without rerunning orchestration',
          generatedAttachments: [],
          youtubeUrls: [],
          routingDecisions: [{ type: 'reuse' }],
          rejectedAttachments: [],
          capabilityRegistry: { routingVersion: '2026-03-05' },
        },
      });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  }, async () => {
    const result = await orchestrateMultimodalTurn({
      prompt: 'Generate a PDF from this text',
      attachments: [],
    });
    assert.equal(result.prompt.includes('Queued job finished without rerunning orchestration'), true);
    assert.equal(result.routeInfo.handled, true);
  });
  assert.equal(calls.some((call) => call.url === '/api/multimodal/orchestrate'), true);
  assert.equal(calls.some((call) => call.url === '/api/multimodal/jobs/mmjob_reused'), true);
});

// eslint-disable-next-line no-console
console.log('Multimodal orchestrator tests completed.');
