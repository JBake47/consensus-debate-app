const MULTIMODAL_ORCHESTRATE_URL = '/api/multimodal/orchestrate';
const MULTIMODAL_JOBS_URL = '/api/multimodal/jobs';
const MULTIMODAL_JOB_TIMEOUT_MS = 50_000;
const MULTIMODAL_JOB_POLL_MS = 1_200;

const YOUTUBE_URL_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s]+|youtube\.com\/shorts\/[^\s]+|youtu\.be\/[^\s]+)/i;
const IMAGE_INTENT_REGEX = /\b(generate|create|make|draw|design|render)\b[\s\S]{0,80}\b(image|picture|photo|illustration|logo|cover art|artwork|icon)\b/i;
const DOC_INTENT_REGEX = /\b(generate|create|make|produce|export|output|save|convert)\b[\s\S]{0,80}\b(pdf|docx|word document|xlsx|excel|spreadsheet)\b/i;

export function shouldCallOrchestrator(prompt) {
  const text = String(prompt || '');
  return YOUTUBE_URL_REGEX.test(text) || IMAGE_INTENT_REGEX.test(text) || DOC_INTENT_REGEX.test(text);
}

export function normalizeGeneratedAttachment(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.name || '').trim();
  if (!name) return null;
  const size = Number(item.size || 0);
  return {
    name,
    size: Number.isFinite(size) ? Math.max(0, size) : 0,
    type: String(item.type || 'application/octet-stream'),
    category: String(item.category || 'binary'),
    content: item.content || '',
    preview: item.preview || (item.category === 'image' ? 'image' : 'text'),
    dataUrl: item.dataUrl || null,
    downloadUrl: item.downloadUrl || null,
    expiresAt: Number(item.expiresAt || 0) || null,
    storageId: item.storageId || null,
    inlineWarning: item.inlineWarning || null,
    generated: true,
    generatedFormat: item.generatedFormat || null,
    provenance: item.provenance || null,
  };
}

function buildOrchestrationPayload({
  prompt,
  attachments,
  selectedModels,
  synthesizerModel,
  providerStatus,
  apiKey,
  routingPreferences,
}) {
  return {
    prompt,
    attachments,
    selectedModels,
    synthesizerModel,
    providerStatus,
    routingPreferences: routingPreferences && typeof routingPreferences === 'object'
      ? routingPreferences
      : {},
    clientApiKey: apiKey || undefined,
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function submitMultimodalJob(payload) {
  const response = await fetch(MULTIMODAL_JOBS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(errText || 'Failed to enqueue multimodal orchestration job');
  }
  return response.json();
}

async function pollMultimodalJob(jobId, { timeoutMs, pollIntervalMs }) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${MULTIMODAL_JOBS_URL}/${encodeURIComponent(jobId)}`);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || 'Failed to poll multimodal orchestration job');
      }
      const data = await response.json();
      if (data?.status === 'completed') {
        return data.result || {};
      }
      if (data?.status === 'failed') {
        throw new Error(data.error || 'Multimodal orchestration job failed');
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await delay(pollIntervalMs);
  }
  throw lastError || new Error('Multimodal orchestration job timed out');
}

function normalizeOrchestrationResponse({
  data,
  prompt,
  attachments,
}) {
  const generated = Array.isArray(data.generatedAttachments)
    ? data.generatedAttachments.map(normalizeGeneratedAttachment).filter(Boolean)
    : [];
  const mergedAttachments = [...attachments, ...generated];
  const promptAugmentation = String(data.promptAugmentation || '').trim();
  const nextPrompt = promptAugmentation
    ? `${prompt}\n\n---\n${promptAugmentation}`
    : prompt;

  return {
    prompt: nextPrompt,
    attachments: mergedAttachments,
    modelOverrides: Array.isArray(data.modelOverrides) ? data.modelOverrides : null,
    routeInfo: {
      youtubeUrls: Array.isArray(data.youtubeUrls) ? data.youtubeUrls : [],
      routingDecisions: Array.isArray(data.routingDecisions) ? data.routingDecisions : [],
      rejectedAttachments: Array.isArray(data.rejectedAttachments) ? data.rejectedAttachments : [],
      capabilityRegistry: data.capabilityRegistry || null,
      handled: Boolean(data.handled),
    },
  };
}

async function runSyncOrchestration(payload) {
  const response = await fetch(MULTIMODAL_ORCHESTRATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(errText || 'Failed to run multimodal orchestration');
  }
  const data = await response.json();
  if (response.status === 202 && data?.jobId) {
    return pollMultimodalJob(data.jobId, {
      timeoutMs: MULTIMODAL_JOB_TIMEOUT_MS,
      pollIntervalMs: MULTIMODAL_JOB_POLL_MS,
    });
  }
  return data;
}

export async function orchestrateMultimodalTurn({
  prompt,
  attachments = [],
  selectedModels = [],
  synthesizerModel = '',
  providerStatus = {},
  apiKey = '',
  routingPreferences = {},
}) {
  const userPrompt = String(prompt || '').trim();
  if (!shouldCallOrchestrator(userPrompt)) {
    return {
      prompt: userPrompt,
      attachments,
      modelOverrides: null,
      routeInfo: null,
    };
  }

  const payload = buildOrchestrationPayload({
    prompt: userPrompt,
    attachments: Array.isArray(attachments) ? attachments : [],
    selectedModels: Array.isArray(selectedModels) ? selectedModels : [],
    synthesizerModel,
    providerStatus,
    apiKey,
    routingPreferences,
  });

  let data = null;
  try {
    const job = await submitMultimodalJob(payload);
    if (!job?.jobId) {
      throw new Error('Multimodal job submission did not return a job id');
    }
    data = await pollMultimodalJob(job.jobId, {
      timeoutMs: MULTIMODAL_JOB_TIMEOUT_MS,
      pollIntervalMs: MULTIMODAL_JOB_POLL_MS,
    });
  } catch {
    data = await runSyncOrchestration(payload);
  }

  return normalizeOrchestrationResponse({
    data,
    prompt: userPrompt,
    attachments: Array.isArray(attachments) ? attachments : [],
  });
}
