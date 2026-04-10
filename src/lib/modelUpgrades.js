import { getModelImageSupport } from './modelCapabilities.js';
import {
  getCatalogModelLookupId,
  getContextLength,
  getMaxOutput,
  getModelStatSnapshot,
} from './modelStats.js';
import {
  getModelFamily,
  getModelReleaseTimestampMs,
  isPreviewModel,
} from './modelRanking.js';
import { canUseNativeWebSearch } from './webSearch.js';

const ALWAYS_ENABLED_PROVIDER_STATUS = {
  openrouter: true,
  anthropic: true,
  openai: true,
  gemini: true,
};
const IGNORED_TRACK_TOKENS = new Set([
  'preview',
  'beta',
  'alpha',
  'exp',
  'experimental',
  'latest',
  'stable',
]);
const MAX_SAFE_PRICE_INCREASE_RATIO = 1.6;
const ROLE_PRIORITY = {
  debate: 0,
  synth: 1,
  convergence: 2,
  search: 3,
};
const UPGRADE_POLICY_VALUES = new Set(['pinned', 'notify', 'auto']);

function normalizeStringArray(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
}

function getProviderFromCatalogId(modelId) {
  const catalogId = getCatalogModelLookupId(modelId);
  return catalogId.includes('/') ? catalogId.split('/')[0] : '';
}

function getTrackTokens(modelId) {
  const catalogId = getCatalogModelLookupId(modelId).toLowerCase();
  const raw = catalogId.includes('/') ? catalogId.split('/').slice(1).join('/') : catalogId;
  return raw
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !IGNORED_TRACK_TOKENS.has(token));
}

export function getModelUpgradeTrack(modelId) {
  const tokens = getTrackTokens(modelId);
  return tokens.join('-') || getCatalogModelLookupId(modelId).toLowerCase();
}

export function normalizeModelUpgradePolicy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return UPGRADE_POLICY_VALUES.has(normalized) ? normalized : 'notify';
}

export function getModelUpgradeTargetKey(role, modelId = '') {
  const normalizedRole = String(role || '').trim();
  if (normalizedRole === 'debate') {
    return `debate:${String(modelId || '').trim()}`;
  }
  if (normalizedRole === 'synth' || normalizedRole === 'convergence' || normalizedRole === 'search') {
    return normalizedRole;
  }
  return `${normalizedRole}:${String(modelId || '').trim()}`;
}

export function buildConfiguredModelUpgradeTargets({
  selectedModels = [],
  synthesizerModel = '',
  convergenceModel = '',
  webSearchModel = '',
  policies = {},
} = {}) {
  const safePolicies = policies && typeof policies === 'object' && !Array.isArray(policies)
    ? policies
    : {};
  const targets = [
    ...((Array.isArray(selectedModels) ? selectedModels : [])
      .map((modelId, index) => ({
        role: 'debate',
        label: `Debate model ${index + 1}`,
        roleLabel: 'Debate roster',
        modelId,
      }))),
    { role: 'synth', label: 'Synthesis', roleLabel: 'Synthesis', modelId: synthesizerModel },
    { role: 'convergence', label: 'Convergence', roleLabel: 'Convergence', modelId: convergenceModel },
    { role: 'search', label: 'Web search', roleLabel: 'Web search', modelId: webSearchModel },
  ]
    .filter((entry) => String(entry?.modelId || '').trim())
    .map((entry) => {
      const key = getModelUpgradeTargetKey(entry.role, entry.modelId);
      return {
        ...entry,
        key,
        policy: normalizeModelUpgradePolicy(safePolicies[key]),
      };
    });

  const seenKeys = new Set();
  return targets.filter((entry) => {
    if (seenKeys.has(entry.key)) return false;
    seenKeys.add(entry.key);
    return true;
  });
}

function getVersionParts(modelId) {
  const catalogId = getCatalogModelLookupId(modelId).toLowerCase();
  const matches = catalogId.match(/\d+(?:\.\d+)?/g) || [];
  return matches.flatMap((part) => part.split('.').map((value) => Number(value)));
}

function compareNumberArrays(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(a[index]) ? a[index] : 0;
    const rightValue = Number.isFinite(b[index]) ? b[index] : 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  return 0;
}

function getCombinedPricePerMillion(modelInfo = {}) {
  const stats = getModelStatSnapshot(modelInfo);
  if (stats.inputPrice == null || stats.outputPrice == null) return null;
  return stats.inputPrice + stats.outputPrice;
}

function supportsNativeSearch(modelId, modelCatalog) {
  return canUseNativeWebSearch({
    model: modelId,
    providerStatus: ALWAYS_ENABLED_PROVIDER_STATUS,
    modelCatalog,
  });
}

function buildUpgradeSafetyResult(safe, reasons = []) {
  return {
    safe,
    reasons,
    message: reasons[0] || '',
  };
}

function evaluateUpgradeCandidateSafety({
  currentCatalogId,
  currentInfo,
  candidateCatalogId,
  candidateInfo,
  modelCatalog,
}) {
  const reasons = [];
  const currentPreview = isPreviewModel(currentCatalogId, currentInfo);
  const candidatePreview = isPreviewModel(candidateCatalogId, candidateInfo);
  if (!currentPreview && candidatePreview) {
    reasons.push('Preview-only release, so it is not marked safe for automatic switching.');
  }

  const currentContextLength = getContextLength(currentInfo || {});
  const candidateContextLength = getContextLength(candidateInfo || {});
  if (
    Number.isFinite(currentContextLength) &&
    currentContextLength > 0 &&
    Number.isFinite(candidateContextLength) &&
    candidateContextLength > 0 &&
    candidateContextLength < currentContextLength
  ) {
    reasons.push('Smaller context window than the current model.');
  }

  const currentMaxOutput = getMaxOutput(currentInfo || {});
  const candidateMaxOutput = getMaxOutput(candidateInfo || {});
  if (
    Number.isFinite(currentMaxOutput) &&
    currentMaxOutput > 0 &&
    Number.isFinite(candidateMaxOutput) &&
    candidateMaxOutput > 0 &&
    candidateMaxOutput < currentMaxOutput
  ) {
    reasons.push('Lower max output than the current model.');
  }

  const currentImageSupport = getModelImageSupport(currentInfo || {});
  const candidateImageSupport = getModelImageSupport(candidateInfo || {});
  if (currentImageSupport === true && candidateImageSupport === false) {
    reasons.push('Loses image support that the current model has.');
  }

  const currentSearchSupport = supportsNativeSearch(currentCatalogId, modelCatalog);
  const candidateSearchSupport = supportsNativeSearch(candidateCatalogId, modelCatalog);
  if (currentSearchSupport && !candidateSearchSupport) {
    reasons.push('Loses native web search support that the current model has.');
  }

  const currentPrice = getCombinedPricePerMillion(currentInfo || {});
  const candidatePrice = getCombinedPricePerMillion(candidateInfo || {});
  if (
    currentPrice != null &&
    candidatePrice != null &&
    currentPrice > 0 &&
    candidatePrice > currentPrice * MAX_SAFE_PRICE_INCREASE_RATIO
  ) {
    const increasePct = Math.round(((candidatePrice / currentPrice) - 1) * 100);
    reasons.push(`Estimated token pricing is about ${increasePct}% higher than the current model.`);
  }

  if (reasons.length === 0) {
    return buildUpgradeSafetyResult(true);
  }

  return buildUpgradeSafetyResult(false, reasons);
}

function normalizeUpgradeFamily(modelId, modelInfo = {}) {
  const family = String(getModelFamily(modelId, modelInfo) || '').trim().toLowerCase();
  if (!family) return '';
  return family.replace(/(\d+)\.\d+$/, '$1');
}

function isCandidateNewer(currentCatalogId, currentInfo, candidateCatalogId, candidateInfo) {
  const currentRelease = getModelReleaseTimestampMs(currentInfo || {});
  const candidateRelease = getModelReleaseTimestampMs(candidateInfo || {});
  if (
    Number.isFinite(currentRelease) &&
    Number.isFinite(candidateRelease) &&
    candidateRelease !== currentRelease
  ) {
    return candidateRelease > currentRelease;
  }

  return compareNumberArrays(getVersionParts(candidateCatalogId), getVersionParts(currentCatalogId)) > 0;
}

function compareUpgradeCandidates(left, right) {
  const leftRelease = getModelReleaseTimestampMs(left.modelInfo || {});
  const rightRelease = getModelReleaseTimestampMs(right.modelInfo || {});
  if (Number.isFinite(leftRelease) && Number.isFinite(rightRelease) && leftRelease !== rightRelease) {
    return rightRelease - leftRelease;
  }

  const versionCompare = compareNumberArrays(
    getVersionParts(left.modelId),
    getVersionParts(right.modelId),
  );
  if (versionCompare !== 0) {
    return versionCompare > 0 ? -1 : 1;
  }

  const leftOutput = getMaxOutput(left.modelInfo || {}) || 0;
  const rightOutput = getMaxOutput(right.modelInfo || {}) || 0;
  if (leftOutput !== rightOutput) {
    return rightOutput - leftOutput;
  }

  const leftContext = getContextLength(left.modelInfo || {}) || 0;
  const rightContext = getContextLength(right.modelInfo || {}) || 0;
  if (leftContext !== rightContext) {
    return rightContext - leftContext;
  }

  return String(left.modelId || '').localeCompare(String(right.modelId || ''));
}

export function formatUpgradeModelIdLikeSource(sourceModelId, targetCatalogId) {
  const source = String(sourceModelId || '').trim();
  const target = String(targetCatalogId || '').trim();
  if (!source || !target) return target;

  if (!source.includes(':')) {
    return target;
  }

  const sourcePrefix = source.split(':')[0];
  const targetWithoutProvider = target.includes('/') ? target.split('/').slice(1).join('/') : target;
  return `${sourcePrefix}:${targetWithoutProvider}`;
}

export function findBestModelUpgrade(modelId, modelCatalog = {}) {
  const sourceModelId = String(modelId || '').trim();
  const currentCatalogId = getCatalogModelLookupId(sourceModelId);
  if (!currentCatalogId) return null;

  const currentInfo = modelCatalog?.[currentCatalogId] || null;
  if (!currentInfo) return null;

  const currentProvider = getProviderFromCatalogId(currentCatalogId);
  const currentFamily = normalizeUpgradeFamily(currentCatalogId, currentInfo);
  const currentTrack = getModelUpgradeTrack(currentCatalogId);
  if (!currentProvider || !currentFamily || !currentTrack) return null;

  const candidates = Object.entries(modelCatalog || {})
    .filter(([candidateCatalogId]) => candidateCatalogId !== currentCatalogId)
    .filter(([candidateCatalogId, candidateInfo]) => (
      getProviderFromCatalogId(candidateCatalogId) === currentProvider
      && normalizeUpgradeFamily(candidateCatalogId, candidateInfo) === currentFamily
      && getModelUpgradeTrack(candidateCatalogId) === currentTrack
    ))
    .filter(([candidateCatalogId, candidateInfo]) => (
      isCandidateNewer(currentCatalogId, currentInfo, candidateCatalogId, candidateInfo)
    ))
    .map(([candidateCatalogId, candidateInfo]) => ({
      modelId: candidateCatalogId,
      modelInfo: candidateInfo,
      safety: evaluateUpgradeCandidateSafety({
        currentCatalogId,
        currentInfo,
        candidateCatalogId,
        candidateInfo,
        modelCatalog,
      }),
    }))
    .sort(compareUpgradeCandidates);

  if (candidates.length === 0) return null;

  const best = candidates.find((candidate) => candidate.safety?.safe) || candidates[0];
  return {
    currentModel: sourceModelId,
    currentCatalogId,
    currentModelInfo: currentInfo,
    suggestedModel: formatUpgradeModelIdLikeSource(sourceModelId, best.modelId),
    suggestedCatalogId: best.modelId,
    suggestedModelInfo: best.modelInfo,
    isSafe: best.safety?.safe !== false,
    safetyMessage: best.safety?.message || '',
    safetyReasons: Array.isArray(best.safety?.reasons) ? best.safety.reasons : [],
    family: currentFamily,
    track: currentTrack,
  };
}

function buildTrackedRoles({
  selectedModels,
  synthesizerModel,
  convergenceModel,
  webSearchModel,
  policies,
}) {
  return buildConfiguredModelUpgradeTargets({
    selectedModels,
    synthesizerModel,
    convergenceModel,
    webSearchModel,
    policies,
  });
}

function sortSuggestionTargets(targets = []) {
  return [...(Array.isArray(targets) ? targets : [])].sort((left, right) => {
    const leftPriority = ROLE_PRIORITY[left?.role] ?? 99;
    const rightPriority = ROLE_PRIORITY[right?.role] ?? 99;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return String(left?.key || '').localeCompare(String(right?.key || ''));
  });
}

function compareSuggestions(left, right) {
  const leftPriority = Math.min(...left.roles.map((role) => ROLE_PRIORITY[role] ?? 99));
  const rightPriority = Math.min(...right.roles.map((role) => ROLE_PRIORITY[role] ?? 99));
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftRelease = getModelReleaseTimestampMs(left.suggestedModelInfo || {});
  const rightRelease = getModelReleaseTimestampMs(right.suggestedModelInfo || {});
  if (Number.isFinite(leftRelease) && Number.isFinite(rightRelease) && leftRelease !== rightRelease) {
    return rightRelease - leftRelease;
  }

  return String(left.currentModel || '').localeCompare(String(right.currentModel || ''));
}

export function buildModelUpgradeSuggestionKey(currentModel, suggestedModel) {
  return `${String(currentModel || '').trim()}=>${String(suggestedModel || '').trim()}`;
}

export function buildModelUpgradeSuggestions({
  selectedModels = [],
  synthesizerModel = '',
  convergenceModel = '',
  webSearchModel = '',
  modelCatalog = {},
  policies = {},
  dismissedSuggestionKeys = [],
} = {}) {
  const dismissed = new Set(normalizeStringArray(dismissedSuggestionKeys));
  const trackedRoles = buildTrackedRoles({
    selectedModels,
    synthesizerModel,
    convergenceModel,
    webSearchModel,
    policies,
  });
  const suggestions = new Map();

  for (const roleEntry of trackedRoles) {
    if (roleEntry.policy === 'pinned') continue;

    const upgrade = findBestModelUpgrade(roleEntry.modelId, modelCatalog);
    if (!upgrade) continue;

    const key = buildModelUpgradeSuggestionKey(upgrade.currentModel, upgrade.suggestedModel);
    if (dismissed.has(key) && !(roleEntry.policy === 'auto' && upgrade.isSafe)) continue;

    const existing = suggestions.get(key);
    if (existing) {
      existing.targets = sortSuggestionTargets([...existing.targets, roleEntry]);
      continue;
    }

    suggestions.set(key, {
      key,
      currentModel: upgrade.currentModel,
      currentCatalogId: upgrade.currentCatalogId,
      currentModelInfo: upgrade.currentModelInfo,
      suggestedModel: upgrade.suggestedModel,
      suggestedCatalogId: upgrade.suggestedCatalogId,
      suggestedModelInfo: upgrade.suggestedModelInfo,
      isSafe: upgrade.isSafe,
      safetyMessage: upgrade.safetyMessage,
      safetyReasons: upgrade.safetyReasons,
      family: upgrade.family,
      track: upgrade.track,
      targets: [roleEntry],
    });
  }

  return Array.from(suggestions.values())
    .map((suggestion) => {
      const targets = sortSuggestionTargets(suggestion.targets);
      const roles = normalizeStringArray(targets.map((target) => target.role));
      const roleLabels = normalizeStringArray(targets.map((target) => target.roleLabel || target.label));
      const safeForAuto = suggestion.isSafe !== false;
      const autoTargetCount = safeForAuto
        ? targets.filter((target) => target.policy === 'auto').length
        : 0;
      const notifyTargetCount = targets.filter((target) => (
        target.policy === 'notify' || (!safeForAuto && target.policy === 'auto')
      )).length;

      return {
        ...suggestion,
        targets,
        roles,
        roleLabels,
        isSafe: safeForAuto,
        autoTargetCount,
        notifyTargetCount,
      };
    })
    .sort(compareSuggestions);
}
