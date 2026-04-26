import {
  getAttachmentTransportForModel,
  getPdfOcrCandidatePages,
  isPdfOcrRequired,
} from './attachmentRouting.js';

const MULTIMODAL_ORCHESTRATE_URL = '/api/multimodal/orchestrate';
const MULTIMODAL_JOBS_URL = '/api/multimodal/jobs';
const MULTIMODAL_JOB_TIMEOUT_MS = 50_000;
const MULTIMODAL_JOB_POLL_MS = 1_200;

const YOUTUBE_URL_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s]+|youtube\.com\/shorts\/[^\s]+|youtu\.be\/[^\s]+)/i;
const IMAGE_INTENT_REGEX = /\b(generate|create|make|draw|design|render)\b[\s\S]{0,80}\b(image|picture|photo|illustration|logo|cover art|artwork|icon)\b/i;
const DOC_INTENT_REGEX = /\b(generate|create|make|produce|export|output|save|convert)\b[\s\S]{0,80}\b(pdf|docx|word document|xlsx|excel|spreadsheet)\b/i;

function needsImageOcrFallback({
  attachments = [],
  selectedModels = [],
  modelCatalog = {},
  capabilityRegistry = null,
}) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const safeModels = Array.isArray(selectedModels) ? selectedModels.filter(Boolean) : [];
  if (safeAttachments.length === 0 || safeModels.length === 0) return false;

  return safeAttachments.some((attachment) => {
    if (String(attachment?.category || '').toLowerCase() !== 'image' || !attachment?.dataUrl) {
      return false;
    }
    return safeModels.some((modelId) => {
      const route = getAttachmentTransportForModel(attachment, modelId, modelCatalog, capabilityRegistry);
      return route.mode === 'excluded';
    });
  });
}

function needsPdfOcrFallback({ attachments = [] }) {
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  return safeAttachments.some((attachment) => (
    isPdfOcrRequired(attachment)
      && !String(attachment?.content || '').trim()
      && getPdfOcrCandidatePages(attachment).length > 0
  ));
}

export function shouldCallOrchestrator(prompt, options = {}) {
  const text = String(prompt || '');
  return YOUTUBE_URL_REGEX.test(text)
    || IMAGE_INTENT_REGEX.test(text)
    || DOC_INTENT_REGEX.test(text)
    || needsImageOcrFallback(options)
    || needsPdfOcrFallback(options);
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

function createAbortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('Multimodal orchestration was aborted.', 'AbortError');
  }
  const error = new Error('Multimodal orchestration was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener?.('abort', handleAbort);
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const handleAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.('abort', handleAbort);
      reject(createAbortError());
    };
    signal?.addEventListener?.('abort', handleAbort, { once: true });
  });
}

async function submitMultimodalJob(payload, { signal } = {}) {
  throwIfAborted(signal);
  const response = await fetch(MULTIMODAL_JOBS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(errText || 'Failed to enqueue multimodal orchestration job');
  }
  return response.json();
}

async function pollMultimodalJob(jobId, { timeoutMs, pollIntervalMs, signal }) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    try {
      const response = await fetch(`${MULTIMODAL_JOBS_URL}/${encodeURIComponent(jobId)}`, { signal });
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
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }
      lastError = error;
    }
    await delay(pollIntervalMs, signal);
  }
  throw lastError || new Error('Multimodal orchestration job timed out');
}

function normalizeOrchestrationResponse({
  data,
  prompt,
  attachments,
}) {
  const attachmentAugmentations = Array.isArray(data?.attachmentAugmentations)
    ? data.attachmentAugmentations
    : [];
  const mergedInputAttachments = attachmentAugmentations.length > 0
    ? attachments.map((attachment, index) => {
      const augmentation = attachmentAugmentations.find((item) => Number(item?.index) === index);
      if (!augmentation) return attachment;
      const nextAttachment = { ...attachment };
      if (typeof augmentation.content === 'string') {
        nextAttachment.content = augmentation.content;
      }
      if (typeof augmentation.inlineWarning === 'string') {
        nextAttachment.inlineWarning = augmentation.inlineWarning;
      }
      if (typeof augmentation.pdfOcrStatus === 'string') {
        nextAttachment.pdfOcrStatus = augmentation.pdfOcrStatus;
      }
      if (augmentation.previewMeta && typeof augmentation.previewMeta === 'object') {
        nextAttachment.previewMeta = {
          ...(nextAttachment.previewMeta || {}),
          ...augmentation.previewMeta,
        };
      }
      if (augmentation.dropPdfOcrPages) {
        delete nextAttachment.pdfOcrPages;
      }
      return nextAttachment;
    })
    : attachments;
  const generated = Array.isArray(data.generatedAttachments)
    ? data.generatedAttachments.map(normalizeGeneratedAttachment).filter(Boolean)
    : [];
  const mergedAttachments = [...mergedInputAttachments, ...generated];
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

async function runSyncOrchestration(payload, { signal } = {}) {
  throwIfAborted(signal);
  const response = await fetch(MULTIMODAL_ORCHESTRATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
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
      signal,
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
  modelCatalog = {},
  capabilityRegistry = null,
  signal,
}) {
  const userPrompt = String(prompt || '').trim();
  if (!shouldCallOrchestrator(userPrompt, {
    attachments,
    selectedModels,
    modelCatalog,
    capabilityRegistry,
  })) {
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
    const job = await submitMultimodalJob(payload, { signal });
    if (!job?.jobId) {
      throw new Error('Multimodal job submission did not return a job id');
    }
    data = await pollMultimodalJob(job.jobId, {
      timeoutMs: MULTIMODAL_JOB_TIMEOUT_MS,
      pollIntervalMs: MULTIMODAL_JOB_POLL_MS,
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }
    data = await runSyncOrchestration(payload, { signal });
  }

  return normalizeOrchestrationResponse({
    data,
    prompt: userPrompt,
    attachments: Array.isArray(attachments) ? attachments : [],
  });
}
