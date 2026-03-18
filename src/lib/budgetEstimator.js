import { getEstimatedModelPricingPerMillion } from './modelRanking.js';
import {
  buildTurnCallWorkload,
  estimateAttachmentTokens,
  estimateTokensFromText,
} from './modelWorkload.js';

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

  const promptTokensBase = estimateTokensFromText(prompt) + estimateAttachmentTokens(attachments);
  const calls = buildTurnCallWorkload({
    promptTokensBase,
    mode,
    selectedModels,
    synthesizerModel,
    convergenceModel,
    webSearchModel,
    maxDebateRounds,
    webSearchEnabled,
  });

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
