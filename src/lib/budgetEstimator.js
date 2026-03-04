import { getEstimatedModelPricingPerMillion } from './modelRanking';

function estimateTokensFromText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return 0;
  return Math.max(8, Math.round(normalized.length / 4));
}

function estimateAttachmentTokens(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return 0;
  return attachments.reduce((sum, attachment) => {
    if (!attachment) return sum;
    const content = String(attachment.content || attachment.preview || '');
    if (!content) return sum + 120;
    return sum + Math.max(80, Math.round(content.length / 5));
  }, 0);
}

function estimateCallCost(modelId, promptTokens, completionTokens, modelCatalog) {
  const pricing = getEstimatedModelPricingPerMillion(modelCatalog?.[modelId] || {});
  if (!pricing) {
    return { cost: 0, quality: 'unknown' };
  }
  const inputCost = (promptTokens * pricing.inputPerMillion) / 1_000_000;
  const outputCost = (completionTokens * pricing.outputPerMillion) / 1_000_000;
  return { cost: inputCost + outputCost, quality: 'estimated' };
}

function combineQuality(values) {
  if (values.length === 0) return 'none';
  if (values.every((value) => value === 'estimated')) return 'estimated';
  if (values.some((value) => value === 'estimated')) return 'partial';
  return 'unknown';
}

export function estimateTurnBudget({
  prompt = '',
  attachments = [],
  mode = 'debate',
  selectedModels = [],
  synthesizerModel = '',
  convergenceModel = '',
  webSearchModel = '',
  maxDebateRounds = 3,
  webSearchEnabled = false,
  modelCatalog = {},
}) {
  if (!String(prompt || '').trim() && (!Array.isArray(attachments) || attachments.length === 0)) {
    return {
      totalEstimatedCost: 0,
      quality: 'none',
      estimatedPromptTokens: 0,
      estimatedCompletionTokens: 0,
      estimatedTotalTokens: 0,
      estimatedCalls: 0,
      breakdown: [],
    };
  }

  const modelCount = Math.max(1, Array.isArray(selectedModels) ? selectedModels.length : 0);
  const promptTokensBase = estimateTokensFromText(prompt) + estimateAttachmentTokens(attachments);
  const calls = [];

  if (webSearchEnabled && webSearchModel) {
    calls.push({
      model: webSearchModel,
      kind: 'web_search',
      promptTokens: Math.round(promptTokensBase * 1.15),
      completionTokens: 500,
    });
  }

  if (mode === 'parallel') {
    for (const model of selectedModels) {
      calls.push({
        model,
        kind: 'parallel_response',
        promptTokens: promptTokensBase,
        completionTokens: 700,
      });
    }
  } else if (mode === 'direct') {
    for (const model of selectedModels) {
      calls.push({
        model,
        kind: 'ensemble_phase1',
        promptTokens: promptTokensBase,
        completionTokens: 750,
      });
    }
    if (convergenceModel) {
      calls.push({
        model: convergenceModel,
        kind: 'ensemble_vote',
        promptTokens: Math.round((promptTokensBase + modelCount * 620) * 0.8),
        completionTokens: 420,
      });
    }
    if (synthesizerModel) {
      calls.push({
        model: synthesizerModel,
        kind: 'ensemble_synthesis',
        promptTokens: promptTokensBase + modelCount * 750,
        completionTokens: 900,
      });
    }
  } else {
    const rounds = Math.max(1, Number(maxDebateRounds) || 1);
    for (let round = 1; round <= rounds; round += 1) {
      const promptTokens = round === 1
        ? promptTokensBase
        : Math.round(promptTokensBase * 0.35 + modelCount * 520);
      const completionTokens = round === 1 ? 760 : 660;
      for (const model of selectedModels) {
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
        promptTokens: promptTokensBase + modelCount * 700 * Math.max(1, Number(maxDebateRounds) || 1),
        completionTokens: 1000,
      });
    }
  }

  let totalCost = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const quality = [];
  const breakdown = calls.map((call) => {
    promptTokens += call.promptTokens;
    completionTokens += call.completionTokens;
    const costMeta = estimateCallCost(
      call.model,
      call.promptTokens,
      call.completionTokens,
      modelCatalog,
    );
    totalCost += costMeta.cost;
    quality.push(costMeta.quality);
    return {
      ...call,
      estimatedCost: costMeta.cost,
      quality: costMeta.quality,
    };
  });

  return {
    totalEstimatedCost: totalCost,
    quality: combineQuality(quality),
    estimatedPromptTokens: promptTokens,
    estimatedCompletionTokens: completionTokens,
    estimatedTotalTokens: promptTokens + completionTokens,
    estimatedCalls: calls.length,
    breakdown,
  };
}
