export const DEFAULT_REFERENCE_PROMPT_TOKENS = 600;

function clampPositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function estimateTokensFromText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return 0;
  return Math.max(8, Math.round(normalized.length / 4));
}

export function estimateAttachmentTokens(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return 0;
  return attachments.reduce((sum, attachment) => {
    if (!attachment) return sum;
    const content = String(attachment.content || attachment.preview || '');
    if (!content) return sum + 120;
    return sum + Math.max(80, Math.round(content.length / 5));
  }, 0);
}

export function buildTurnCallWorkload({
  promptTokensBase = 0,
  mode = 'debate',
  selectedModels = [],
  synthesizerModel = '',
  convergenceModel = '',
  webSearchModel = '',
  maxDebateRounds = 3,
  webSearchEnabled = false,
}) {
  const normalizedPromptTokens = clampPositiveInteger(promptTokensBase, 0);
  const safeSelectedModels = Array.isArray(selectedModels) ? selectedModels.filter(Boolean) : [];
  const modelCount = Math.max(1, safeSelectedModels.length);
  const calls = [];

  if (webSearchEnabled && webSearchModel) {
    calls.push({
      model: webSearchModel,
      kind: 'web_search',
      promptTokens: Math.round(normalizedPromptTokens * 1.15),
      completionTokens: 500,
    });
  }

  if (mode === 'parallel') {
    for (const model of safeSelectedModels) {
      calls.push({
        model,
        kind: 'parallel_response',
        promptTokens: normalizedPromptTokens,
        completionTokens: 700,
      });
    }
    return calls;
  }

  if (mode === 'direct') {
    for (const model of safeSelectedModels) {
      calls.push({
        model,
        kind: 'ensemble_phase1',
        promptTokens: normalizedPromptTokens,
        completionTokens: 750,
      });
    }
    if (convergenceModel) {
      calls.push({
        model: convergenceModel,
        kind: 'ensemble_vote',
        promptTokens: Math.round((normalizedPromptTokens + modelCount * 620) * 0.8),
        completionTokens: 420,
      });
    }
    if (synthesizerModel) {
      calls.push({
        model: synthesizerModel,
        kind: 'ensemble_synthesis',
        promptTokens: normalizedPromptTokens + modelCount * 750,
        completionTokens: 900,
      });
    }
    return calls;
  }

  const rounds = Math.max(1, clampPositiveInteger(maxDebateRounds, 1));
  for (let round = 1; round <= rounds; round += 1) {
    const promptTokens = round === 1
      ? normalizedPromptTokens
      : Math.round(normalizedPromptTokens * 0.35 + modelCount * 520);
    const completionTokens = round === 1 ? 760 : 660;
    for (const model of safeSelectedModels) {
      calls.push({
        model,
        kind: round === 1 ? 'debate_round1' : `debate_round${round}`,
        promptTokens,
        completionTokens,
      });
    }
    if (round >= 2 && round < rounds && convergenceModel) {
      calls.push({
        model: convergenceModel,
        kind: 'convergence_check',
        promptTokens: Math.round(modelCount * 500),
        completionTokens: 260,
      });
    }
  }
  if (synthesizerModel) {
    calls.push({
      model: synthesizerModel,
      kind: 'debate_synthesis',
      promptTokens: normalizedPromptTokens + modelCount * 700 * rounds,
      completionTokens: 1000,
    });
  }
  return calls;
}

export function summarizeWorkloadForModel(calls = [], modelId = '') {
  const normalizedModelId = String(modelId || '').trim();
  return (Array.isArray(calls) ? calls : []).reduce((summary, call) => {
    if (String(call?.model || '').trim() !== normalizedModelId) return summary;
    summary.callCount += 1;
    summary.inputTokens += clampPositiveInteger(call.promptTokens, 0);
    summary.outputTokens += clampPositiveInteger(call.completionTokens, 0);
    return summary;
  }, {
    role: 'custom',
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
}

export function buildModelWorkloadProfile({
  turnMode = 'debate',
  selectedModelCount = 3,
  maxDebateRounds = 3,
  startRound = 1,
  referencePromptTokens = DEFAULT_REFERENCE_PROMPT_TOKENS,
}) {
  const safeMode = String(turnMode || 'debate').toLowerCase();
  const safeSelectedModelCount = Math.max(1, clampPositiveInteger(selectedModelCount, 3) || 3);
  const safePromptTokens = Math.max(80, clampPositiveInteger(referencePromptTokens, DEFAULT_REFERENCE_PROMPT_TOKENS) || DEFAULT_REFERENCE_PROMPT_TOKENS);
  const safeMaxRounds = Math.max(1, clampPositiveInteger(maxDebateRounds, 3) || 3);
  const safeStartRound = Math.max(1, Math.min(safeMaxRounds, clampPositiveInteger(startRound, 1) || 1));

  if (safeMode === 'parallel') {
    return {
      role: 'parallel_response',
      callCount: 1,
      inputTokens: safePromptTokens,
      outputTokens: 700,
    };
  }

  if (safeMode === 'direct') {
    return {
      role: 'ensemble_phase1',
      callCount: 1,
      inputTokens: safePromptTokens,
      outputTokens: 750,
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let callCount = 0;

  for (let round = safeStartRound; round <= safeMaxRounds; round += 1) {
    inputTokens += round === 1
      ? safePromptTokens
      : Math.round(safePromptTokens * 0.35 + safeSelectedModelCount * 520);
    outputTokens += round === 1 ? 760 : 660;
    callCount += 1;
  }

  return {
    role: 'debate_participant',
    callCount,
    inputTokens,
    outputTokens,
    startRound: safeStartRound,
    maxDebateRounds: safeMaxRounds,
  };
}

export function buildDebateParticipantWorkloadProfile(options = {}) {
  return buildModelWorkloadProfile({ turnMode: 'debate', ...options });
}
