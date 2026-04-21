import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Key, Cpu, Sparkles, Plus, Trash2, RotateCcw, GitCompareArrows, Globe, Shield, DollarSign, Wand2, Gauge, Database, Activity, Sun, Download } from 'lucide-react';
import { useDebateActions, useDebateSettings, useDebateUi } from '../context/DebateContext';
import {
  DEFAULT_DEBATE_MODELS,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_CONVERGENCE_MODEL,
  DEFAULT_MAX_DEBATE_ROUNDS,
  DEFAULT_WEB_SEARCH_MODEL,
  getModelDisplayName,
  getProviderName,
} from '../lib/openrouter';
import {
  applyAppUpdate as requestAppUpdate,
  fetchAppUpdateStatus,
  requestAppRestart,
  waitForAppRestart,
} from '../lib/appUpdate';
import { DEFAULT_RETRY_POLICY } from '../lib/retryPolicy';
import { rankModels, selectDiverseModels } from '../lib/modelRanking';
import {
  buildModelStatsTitle,
  formatPricePerMillion,
  formatTokenQuantity,
  getModelStatSnapshot,
  getModelStatRows,
  getModelStatsUnavailableMessage,
  resolveModelCatalogEntry,
} from '../lib/modelStats';
import { DEFAULT_THEME_MODE } from '../lib/theme';
import { buildModelWorkloadProfile } from '../lib/modelWorkload';
import {
  buildUniquePresetName,
  presetMatchesDraft,
  resolvePresetSelection,
} from '../lib/modelPresets';
import ModelPickerModal from './ModelPickerModal';
import InfoTip from './InfoTip';
import './SettingsModal.css';

const DEFAULT_CONVERGENCE_ON_FINAL_ROUND = true;
const LAST_MODEL_PRESET_ID_STORAGE_KEY = 'last_model_preset_id';
const SETTINGS_PANE_HELP = {
  general: 'Browser-local setup like provider credentials, theme, and app maintenance.',
  models: 'Choose who debates, how many rounds they run, who synthesizes, who checks convergence, and which model handles web search.',
  reliability: 'Control retries, diagnostics, and provider recovery behavior.',
  budget: 'Warn before expensive turns so you can cap or approve spend intentionally.',
  performance: 'Trade memory and fidelity for smoother rendering and faster repeat runs.',
};
const PROVIDER_FIELD_HELP = [
  'Choose where this model ID should be resolved.',
  'OpenRouter uses full catalog IDs. Direct providers add the provider prefix automatically.',
];
const DEFAULT_PROMPT_CACHE_POLICY = {
  enabled: true,
  claudeTtl: 'default',
  openaiRetention: 'default',
  geminiExplicit: true,
  geminiTtlSeconds: 300,
  warmupSerialization: true,
};
const MODEL_UPGRADE_POLICY_OPTIONS = [
  {
    value: 'pinned',
    label: 'Pinned',
    compactLabel: 'Pinned',
    description: 'Keep this selection fixed. No notices or automatic switches.',
  },
  {
    value: 'notify',
    label: 'Notify',
    compactLabel: 'Notify',
    description: 'Show a notice when a newer safe same-track version is available.',
  },
  {
    value: 'auto',
    label: 'Auto-upgrade safe',
    compactLabel: 'Auto',
    description: 'Switch future turns to a newer safe same-track version automatically.',
  },
];

function formatDurationCompact(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatRankingTelemetrySummary(item) {
  const requestCount = Number(item?.telemetry?.requestCount || 0);
  const qualityVotes = Number(item?.qualityBreakdown?.feedback?.voteCount || 0);
  const feedbackSummary = String(item?.qualityBreakdown?.feedback?.summary || '').trim();
  const benchmarkLabel = String(item?.qualityBreakdown?.benchmark?.label || '').trim();
  const parts = [];

  if (qualityVotes > 0 && feedbackSummary) {
    parts.push(`Judge ${feedbackSummary}`);
  } else if (benchmarkLabel) {
    parts.push(benchmarkLabel);
  }

  if (requestCount > 0) {
    const successRate = Number(item?.telemetry?.successRatePct || 0);
    const p50FirstToken = formatDurationCompact(item?.telemetry?.p50FirstTokenMs);
    const cacheHitRate = Number(item?.telemetry?.cacheHitRatePct || 0);
    parts.push(`Success ${successRate}% across ${requestCount} run${requestCount === 1 ? '' : 's'}`);
    parts.push(`p50 ${p50FirstToken}`);
    parts.push(`cache ${cacheHitRate}%`);
  } else if (parts.length === 0) {
    parts.push('No direct telemetry yet. Ranking is using benchmark priors and catalog metadata.');
  }

  return parts.join(' · ');
}

function ModelStatsHoverCard({
  modelId,
  modelCatalog,
  modelCatalogStatus,
  children,
  focusable = true,
  inline = false,
}) {
  const { catalogId, model } = resolveModelCatalogEntry(modelCatalog, modelId);
  const statRows = getModelStatRows(model);
  const displayName = model?.name || getModelDisplayName(modelId);
  const providerName = getProviderName(modelId);
  const description = String(model?.description || '').trim();
  const missingMessage = getModelStatsUnavailableMessage(modelCatalogStatus);
  const helperText = buildModelStatsTitle({ modelId, modelCatalog, modelCatalogStatus });

  return (
    <div className={`model-hover-card${inline ? ' inline' : ''}`}>
      <div
        className="model-hover-trigger"
        tabIndex={focusable ? 0 : undefined}
        aria-label={focusable ? helperText : undefined}
      >
        {children}
      </div>
      <div className="model-hover-tooltip">
        <div className="model-hover-header">
          <span className="model-hover-provider">{providerName}</span>
          <strong className="model-hover-title">{displayName || modelId}</strong>
          <code className="model-hover-id">{catalogId && catalogId !== modelId ? `${modelId} -> ${catalogId}` : modelId}</code>
        </div>
        {description && <p className="model-hover-description">{description}</p>}
        {model ? (
          <dl className="model-hover-stats">
            {statRows.map((stat) => (
              <div key={stat.key} className="model-hover-stat-row">
                <dt>{stat.label}</dt>
                <dd title={stat.detail}>{stat.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="model-hover-empty">{missingMessage}</p>
        )}
      </div>
    </div>
  );
}

function createPresetId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadLastModelPresetId() {
  try {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(LAST_MODEL_PRESET_ID_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveLastModelPresetId(presetId) {
  try {
    if (typeof window === 'undefined') return;
    if (presetId) {
      window.localStorage.setItem(LAST_MODEL_PRESET_ID_STORAGE_KEY, presetId);
    } else {
      window.localStorage.removeItem(LAST_MODEL_PRESET_ID_STORAGE_KEY);
    }
  } catch {
    // Presets still work when storage is unavailable; only the remembered editor target is skipped.
  }
}

function arraysEqual(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function retryPoliciesEqual(left, right) {
  return (
    Number(left?.maxAttempts) === Number(right?.maxAttempts)
    && Number(left?.baseDelayMs) === Number(right?.baseDelayMs)
    && Number(left?.maxDelayMs) === Number(right?.maxDelayMs)
    && Number(left?.circuitFailureThreshold) === Number(right?.circuitFailureThreshold)
    && Number(left?.circuitCooldownMs) === Number(right?.circuitCooldownMs)
  );
}

function formatFilePreview(items, limit = 4) {
  const entries = (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      return String(item?.path || '').trim();
    })
    .filter(Boolean);

  if (entries.length === 0) return '';
  if (entries.length <= limit) return entries.join(', ');
  return `${entries.slice(0, limit).join(', ')}, +${entries.length - limit} more`;
}

function buildModelUpgradeStatLines(suggestion) {
  const currentStats = getModelStatSnapshot(suggestion?.currentModelInfo || {});
  const nextStats = getModelStatSnapshot(suggestion?.suggestedModelInfo || {});
  const lines = [];

  const contextLine = (
    currentStats.contextLength != null || nextStats.contextLength != null
      ? (
        currentStats.contextLength === nextStats.contextLength
          ? `Context ${formatTokenQuantity(nextStats.contextLength)}`
          : `Context ${formatTokenQuantity(currentStats.contextLength)} -> ${formatTokenQuantity(nextStats.contextLength)}`
      )
      : null
  );
  if (contextLine) lines.push(contextLine);

  const outputLine = (
    currentStats.maxOutput != null || nextStats.maxOutput != null
      ? (
        currentStats.maxOutput === nextStats.maxOutput
          ? `Max output ${formatTokenQuantity(nextStats.maxOutput)}`
          : `Max output ${formatTokenQuantity(currentStats.maxOutput)} -> ${formatTokenQuantity(nextStats.maxOutput)}`
      )
      : null
  );
  if (outputLine) lines.push(outputLine);

  if (
    currentStats.inputPrice != null ||
    currentStats.outputPrice != null ||
    nextStats.inputPrice != null ||
    nextStats.outputPrice != null
  ) {
    const currentPricing = `${formatPricePerMillion(currentStats.inputPrice)} / ${formatPricePerMillion(currentStats.outputPrice)}`;
    const nextPricing = `${formatPricePerMillion(nextStats.inputPrice)} / ${formatPricePerMillion(nextStats.outputPrice)}`;
    lines.push(
      currentPricing === nextPricing
        ? `I/O ${nextPricing}`
        : `I/O ${currentPricing} -> ${nextPricing}`
    );
  }

  return lines;
}

function getModelUpgradePolicyDescription(policy) {
  return MODEL_UPGRADE_POLICY_OPTIONS.find((option) => option.value === policy)?.description
    || MODEL_UPGRADE_POLICY_OPTIONS[1].description;
}

function getModelUpgradePolicyOption(policy) {
  return MODEL_UPGRADE_POLICY_OPTIONS.find((option) => option.value === policy)
    || MODEL_UPGRADE_POLICY_OPTIONS[1];
}

function buildModelUpgradePolicyTooltipText(target) {
  const currentOption = getModelUpgradePolicyOption(target?.policy);
  const optionSummary = MODEL_UPGRADE_POLICY_OPTIONS
    .map((option) => `${option.label}: ${option.description}`)
    .join(' ');
  return `${target?.label || 'Model'} upgrade policy. Current: ${currentOption.label}. ${currentOption.description} Options: ${optionSummary}`;
}

function normalizePromptCachePolicy(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const retention = source.openaiRetention === 'in_memory' ? 'in-memory' : source.openaiRetention;
  const ttlSeconds = Number(source.geminiTtlSeconds);
  return {
    enabled: source.enabled !== false,
    claudeTtl: source.claudeTtl === '1h' ? '1h' : 'default',
    openaiRetention: ['in-memory', '24h'].includes(retention) ? retention : 'default',
    geminiExplicit: source.geminiExplicit !== false,
    geminiTtlSeconds: Number.isFinite(ttlSeconds)
      ? Math.max(60, Math.min(3600, Math.round(ttlSeconds)))
      : DEFAULT_PROMPT_CACHE_POLICY.geminiTtlSeconds,
    warmupSerialization: source.warmupSerialization !== false,
  };
}

function promptCachePoliciesEqual(left, right) {
  const a = normalizePromptCachePolicy(left);
  const b = normalizePromptCachePolicy(right);
  return (
    a.enabled === b.enabled
    && a.claudeTtl === b.claudeTtl
    && a.openaiRetention === b.openaiRetention
    && a.geminiExplicit === b.geminiExplicit
    && a.geminiTtlSeconds === b.geminiTtlSeconds
    && a.warmupSerialization === b.warmupSerialization
  );
}

export default function SettingsModal() {
  const {
    apiKey, selectedModels, synthesizerModel,
    convergenceModel, convergenceOnFinalRound, maxDebateRounds, webSearchModel, strictWebSearch,
    retryPolicy, promptCachePolicy, budgetGuardrailsEnabled, budgetSoftLimitUsd, budgetAutoApproveBelowUsd,
    smartRankingMode, smartRankingPreferFlagship, smartRankingPreferNew, smartRankingAllowPreview,
    modelUpgradeNotificationsEnabled, modelUpgradeTargets, modelUpgradeSuggestions, dismissedModelUpgradeSuggestionCount,
    streamVirtualizationEnabled, streamVirtualizationKeepLatest,
    cachePersistenceEnabled, themeMode, cacheHitCount, cacheEntryCount,
    rememberApiKey, providerStatus, providerStatusState, providerStatusError, modelCatalog, modelCatalogStatus, modelPresets, metrics, capabilityRegistry,
  } = useDebateSettings();
  const { showSettings, pendingSettingsFocus } = useDebateUi();
  const {
    clearResponseCache,
    resetDiagnostics,
    dismissModelUpgrade,
    resetDismissedModelUpgrades,
    setModelUpgradePolicy,
    dispatch,
  } = useDebateActions();
  const [keyInput, setKeyInput] = useState(apiKey);
  const [models, setModels] = useState(selectedModels);
  const [synth, setSynth] = useState(synthesizerModel);
  const [convModel, setConvModel] = useState(convergenceModel);
  const [convOnFinalRound, setConvOnFinalRound] = useState(Boolean(convergenceOnFinalRound));
  const [maxRounds, setMaxRounds] = useState(maxDebateRounds);
  const [searchModel, setSearchModel] = useState(webSearchModel);
  const [strictSearch, setStrictSearch] = useState(strictWebSearch);
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(retryPolicy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts);
  const [retryBaseDelayMs, setRetryBaseDelayMs] = useState(retryPolicy?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs);
  const [retryMaxDelayMs, setRetryMaxDelayMs] = useState(retryPolicy?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs);
  const [circuitFailureThreshold, setCircuitFailureThreshold] = useState(retryPolicy?.circuitFailureThreshold ?? DEFAULT_RETRY_POLICY.circuitFailureThreshold);
  const [circuitCooldownMs, setCircuitCooldownMs] = useState(retryPolicy?.circuitCooldownMs ?? DEFAULT_RETRY_POLICY.circuitCooldownMs);
  const [budgetEnabled, setBudgetEnabled] = useState(Boolean(budgetGuardrailsEnabled));
  const [budgetSoftLimit, setBudgetSoftLimit] = useState(Number(budgetSoftLimitUsd || 0));
  const [budgetAutoApprove, setBudgetAutoApprove] = useState(Number(budgetAutoApproveBelowUsd || 0));
  const [rankingMode, setRankingMode] = useState(smartRankingMode || 'balanced');
  const [rankingPreferFlagship, setRankingPreferFlagship] = useState(Boolean(smartRankingPreferFlagship));
  const [rankingPreferNew, setRankingPreferNew] = useState(Boolean(smartRankingPreferNew));
  const [rankingAllowPreview, setRankingAllowPreview] = useState(Boolean(smartRankingAllowPreview));
  const [upgradeNotificationsEnabled, setUpgradeNotificationsEnabled] = useState(Boolean(modelUpgradeNotificationsEnabled));
  const [virtualizationEnabled, setVirtualizationEnabled] = useState(Boolean(streamVirtualizationEnabled));
  const [virtualizationKeepLatest, setVirtualizationKeepLatest] = useState(Number(streamVirtualizationKeepLatest || 4));
  const [cachePersistence, setCachePersistence] = useState(Boolean(cachePersistenceEnabled));
  const normalizedInitialPromptCachePolicy = normalizePromptCachePolicy(promptCachePolicy);
  const [promptCacheEnabled, setPromptCacheEnabled] = useState(Boolean(normalizedInitialPromptCachePolicy.enabled));
  const [promptCacheClaudeTtl, setPromptCacheClaudeTtl] = useState(normalizedInitialPromptCachePolicy.claudeTtl);
  const [promptCacheOpenAIRetention, setPromptCacheOpenAIRetention] = useState(normalizedInitialPromptCachePolicy.openaiRetention);
  const [promptCacheGeminiExplicit, setPromptCacheGeminiExplicit] = useState(Boolean(normalizedInitialPromptCachePolicy.geminiExplicit));
  const [promptCacheGeminiTtlSeconds, setPromptCacheGeminiTtlSeconds] = useState(Number(normalizedInitialPromptCachePolicy.geminiTtlSeconds));
  const [promptCacheWarmupSerialization, setPromptCacheWarmupSerialization] = useState(Boolean(normalizedInitialPromptCachePolicy.warmupSerialization));
  const [themeSelection, setThemeSelection] = useState(themeMode || DEFAULT_THEME_MODE);
  const [rememberKey, setRememberKey] = useState(rememberApiKey);
  const [debouncedKeyInput, setDebouncedKeyInput] = useState(apiKey);
  const [newModel, setNewModel] = useState('');
  const [newModelProvider, setNewModelProvider] = useState('openrouter');
  const [pickerOpen, setPickerOpen] = useState(null);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetNameInput, setPresetNameInput] = useState('');
  const [presetSheet, setPresetSheet] = useState(null);
  const [presetSheetValue, setPresetSheetValue] = useState('');
  const [appUpdateRestartSheetOpen, setAppUpdateRestartSheetOpen] = useState(false);
  const [synthProvider, setSynthProvider] = useState('openrouter');
  const [convProvider, setConvProvider] = useState('openrouter');
  const [searchProvider, setSearchProvider] = useState('openrouter');
  const [appUpdateStatus, setAppUpdateStatus] = useState(null);
  const [appUpdateState, setAppUpdateState] = useState('idle');
  const [appUpdateError, setAppUpdateError] = useState('');
  const [appUpdateResult, setAppUpdateResult] = useState(null);
  const [activeSettingsPane, setActiveSettingsPane] = useState('general');
  const [focusedSettingsTargetKey, setFocusedSettingsTargetKey] = useState('');
  const presetSheetInputRef = useRef(null);
  const presetEditorScopeRef = useRef('');
  const presetSelectionInitializedRef = useRef(false);
  const liveApplyReadyRef = useRef(false);
  const synthEditingRef = useRef(false);
  const convEditingRef = useRef(false);
  const searchEditingRef = useRef(false);
  const appUpdateRequestIdRef = useRef(0);
  const settingsBodyRef = useRef(null);
  const settingsTargetRefs = useRef(new Map());
  const settingsTargetHighlightTimeoutRef = useRef(0);

  const normalizeModelForProvider = (providerId, rawValue) => {
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) return '';

    if (providerId === 'openrouter') {
      if (trimmed.includes(':')) {
        const [prefixRaw, ...restParts] = trimmed.split(':');
        const rest = restParts.join(':').trim();
        const prefix = prefixRaw.toLowerCase();
        const mappedPrefix = prefix === 'gemini' ? 'google' : prefix;
        if (rest) return `${mappedPrefix}/${rest}`;
      }
      return trimmed;
    }

    const acceptedPrefixes = providerId === 'gemini' ? ['gemini', 'google'] : [providerId];

    if (trimmed.includes(':')) {
      const [prefixRaw, ...restParts] = trimmed.split(':');
      const rest = restParts.join(':').trim();
      if (rest) {
        const prefix = prefixRaw.toLowerCase();
        if (acceptedPrefixes.includes(prefix)) {
          return `${providerId}:${rest}`;
        }
        return `${providerId}:${rest}`;
      }
    }

    if (trimmed.includes('/')) {
      const [prefixRaw, ...restParts] = trimmed.split('/');
      const rest = restParts.join('/').trim();
      if (rest) {
        const prefix = prefixRaw.toLowerCase();
        if (acceptedPrefixes.includes(prefix)) {
          return `${providerId}:${rest}`;
        }
        return `${providerId}:${rest}`;
      }
    }

    return `${providerId}:${trimmed}`;
  };

  const buildPresetPayload = (nameValue) => {
    const trimmedName = String(nameValue || '').trim();
    if (!trimmedName || models.length === 0) return null;
    return {
      name: trimmedName,
      models,
      synthesizerModel: normalizeModelForProvider(synthProvider, synth) || synth,
      convergenceModel: normalizeModelForProvider(convProvider, convModel) || convModel,
      maxDebateRounds: maxRounds,
      webSearchModel: normalizeModelForProvider(searchProvider, searchModel) || searchModel,
    };
  };

  const normalizedSynthValue = normalizeModelForProvider(synthProvider, synth) || synth.trim();
  const normalizedConvergenceValue = normalizeModelForProvider(convProvider, convModel) || convModel.trim();
  const normalizedSearchValue = normalizeModelForProvider(searchProvider, searchModel) || searchModel.trim();
  const draftRetryPolicy = useMemo(() => ({
    maxAttempts: Number(retryMaxAttempts),
    baseDelayMs: Number(retryBaseDelayMs),
    maxDelayMs: Number(retryMaxDelayMs),
    circuitFailureThreshold: Number(circuitFailureThreshold),
    circuitCooldownMs: Number(circuitCooldownMs),
  }), [
    retryMaxAttempts,
    retryBaseDelayMs,
    retryMaxDelayMs,
    circuitFailureThreshold,
    circuitCooldownMs,
  ]);
  const draftPromptCachePolicy = useMemo(() => normalizePromptCachePolicy({
    enabled: promptCacheEnabled,
    claudeTtl: promptCacheClaudeTtl,
    openaiRetention: promptCacheOpenAIRetention,
    geminiExplicit: promptCacheGeminiExplicit,
    geminiTtlSeconds: Number(promptCacheGeminiTtlSeconds),
    warmupSerialization: promptCacheWarmupSerialization,
  }), [
    promptCacheEnabled,
    promptCacheClaudeTtl,
    promptCacheOpenAIRetention,
    promptCacheGeminiExplicit,
    promptCacheGeminiTtlSeconds,
    promptCacheWarmupSerialization,
  ]);

  const handleSave = () => {
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: false });
  };

  const handleClose = () => {
    liveApplyReadyRef.current = false;
    setPresetSheet(null);
    setPresetSheetValue('');
    setAppUpdateRestartSheetOpen(false);
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: false });
  };

  const addModel = () => {
    const trimmed = newModel.trim();
    if (!trimmed) return;
    const modelId = normalizeModelForProvider(newModelProvider, trimmed);
    if (!models.includes(modelId)) {
      setModels([...models, modelId]);
      setNewModel('');
    }
  };

  const addModelId = (modelId) => {
    if (!modelId) return;
    if (!models.includes(modelId)) {
      setModels([...models, modelId]);
    }
  };

  const providerOptions = [
    { id: 'openrouter', label: 'OpenRouter', enabled: providerStatus?.openrouter || Boolean(apiKey) },
    { id: 'anthropic', label: 'Anthropic', enabled: providerStatus?.anthropic },
    { id: 'openai', label: 'OpenAI', enabled: providerStatus?.openai },
    { id: 'gemini', label: 'Gemini', enabled: providerStatus?.gemini },
  ].filter(p => p.enabled);

  const getProviderModelOptions = useMemo(() => {
    if (modelCatalogStatus !== 'ready') return () => [];
    const ids = Object.keys(modelCatalog || {});
    return (providerId) => {
      if (providerId === 'openrouter') return ids;
      const allowedProviders = providerId === 'gemini' ? ['google', 'gemini'] : [providerId];
      const filtered = ids.filter((id) => allowedProviders.includes(id.split('/')[0]));
      const stripped = filtered
        .map((id) => id.split('/').slice(1).join('/'))
        .filter(Boolean);
      return Array.from(new Set(stripped)).sort();
    };
  }, [modelCatalog, modelCatalogStatus]);

  const providerModelOptions = getProviderModelOptions(newModelProvider);
  const getModelStatsTitle = (modelId) => buildModelStatsTitle({
    modelId,
    modelCatalog,
    modelCatalogStatus,
  });
  const rankingWorkloadProfile = useMemo(() => buildModelWorkloadProfile({
    turnMode: 'debate',
    selectedModelCount: Math.max(1, models.length || selectedModels.length || 1),
    maxDebateRounds: maxRounds,
    startRound: 1,
  }), [models.length, selectedModels.length, maxRounds]);
  const rankedModels = useMemo(
    () => rankModels({
      modelCatalog,
      metrics,
      preferredMode: rankingMode,
      rankingPreferences: {
        preferFlagship: rankingPreferFlagship,
        preferNew: rankingPreferNew,
        allowPreview: rankingAllowPreview,
      },
      capabilityRegistry,
      workloadProfile: rankingWorkloadProfile,
      limit: 8,
    }),
    [modelCatalog, metrics, rankingMode, rankingPreferFlagship, rankingPreferNew, rankingAllowPreview, capabilityRegistry, rankingWorkloadProfile]
  );
  const modelUpgradeTargetLookup = useMemo(() => {
    const lookup = new Map();
    for (const target of modelUpgradeTargets) {
      const modelKey = target.role === 'debate' ? target.modelId : '';
      lookup.set(`${target.role}::${modelKey}`, target);
    }
    return lookup;
  }, [modelUpgradeTargets]);
  const modelUpgradeSuggestionLookup = useMemo(() => {
    const lookup = new Map();
    for (const suggestion of modelUpgradeSuggestions) {
      for (const target of suggestion.targets || []) {
        lookup.set(target.key, suggestion);
      }
    }
    return lookup;
  }, [modelUpgradeSuggestions]);
  const getInlineModelUpgradeTarget = (role, modelId = '') => {
    const lookupKey = role === 'debate' ? `${role}::${modelId}` : `${role}::`;
    return modelUpgradeTargetLookup.get(lookupKey) || null;
  };
  const renderCompactModelUpgradePolicyControl = (target, options = {}) => {
    if (!target) return null;
    const currentOption = getModelUpgradePolicyOption(target.policy);
    const tooltipText = buildModelUpgradePolicyTooltipText(target);
    const selectClassName = [
      'settings-input',
      'settings-select',
      'settings-inline-upgrade-select',
      'compact',
      options.className || '',
    ].filter(Boolean).join(' ');

    return (
      <div className={`settings-inline-upgrade-control compact${options.className ? ` ${options.className}` : ''}`}>
        {options.label && (
          <span className="settings-inline-upgrade-label">{options.label}</span>
        )}
        <div className="settings-inline-upgrade-select-wrap">
          <select
            className={selectClassName}
            value={target.policy}
            onChange={(event) => setModelUpgradePolicy(target.key, event.target.value)}
            title={tooltipText}
            aria-label={`${target.label} upgrade policy`}
          >
            {MODEL_UPGRADE_POLICY_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                title={option.description}
                aria-label={`${option.label}. ${option.description}`}
              >
                {option.compactLabel || option.label}
              </option>
            ))}
          </select>
          <div className="settings-inline-upgrade-tooltip" role="tooltip" aria-hidden="true">
            <strong className="settings-inline-upgrade-tooltip-title">{target.label}</strong>
            <span className="settings-inline-upgrade-tooltip-current">
              Current: <strong>{currentOption.label}</strong>. {currentOption.description}
            </span>
            <div className="settings-inline-upgrade-tooltip-options">
              {MODEL_UPGRADE_POLICY_OPTIONS.map((option) => (
                <div
                  key={option.value}
                  className={`settings-inline-upgrade-tooltip-option${option.value === target.policy ? ' selected' : ''}`}
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };
  const renderResolvedModelUpgradeSuggestionNotice = (target) => {
    if (!target) return null;
    const suggestion = modelUpgradeSuggestionLookup.get(target.key) || null;
    if (!suggestion) return null;
    const statSummary = buildModelUpgradeStatLines(suggestion).slice(0, 2).join(' | ');
    const applySuggestionToTarget = () => dispatch({
      type: 'APPLY_MODEL_UPGRADE',
      payload: {
        currentModel: suggestion.currentModel,
        suggestedModel: suggestion.suggestedModel,
        targetKeys: [target.key],
        suggestionKey: suggestion.key,
      },
    });
    const primaryActionLabel = suggestion.isSafe === false ? 'Replace' : 'Switch';
    const primaryActionTitle = suggestion.isSafe === false
      ? `Replace ${suggestion.currentModel} with ${suggestion.suggestedModel} for ${target.label}. This does not enable automatic future switching.`
      : `Replace ${suggestion.currentModel} with ${suggestion.suggestedModel} for ${target.label}.`;

    return (
      <div className={`settings-inline-upgrade-notice${suggestion.isSafe === false ? ' unsafe' : ''}`}>
        <div className="settings-inline-upgrade-notice-copy">
          <span className="settings-inline-upgrade-notice-title">
            <ModelStatsHoverCard
              modelId={suggestion.suggestedModel}
              modelCatalog={modelCatalog}
              modelCatalogStatus={modelCatalogStatus}
              focusable={false}
              inline
            >
              <strong className="settings-inline-upgrade-model-name">
                {getModelDisplayName(suggestion.suggestedModel)}
              </strong>
            </ModelStatsHoverCard>{' '}
            is available
          </span>
          <code>{suggestion.suggestedModel}</code>
          {statSummary && (
            <span className="settings-inline-upgrade-meta">{statSummary}</span>
          )}
          {suggestion.isSafe === false && suggestion.safetyMessage && (
            <span className="settings-inline-upgrade-warning">{suggestion.safetyMessage}</span>
          )}
        </div>
        <div className="settings-inline-upgrade-actions">
          <button
            type="button"
            className="settings-inline-upgrade-action primary"
            onClick={applySuggestionToTarget}
            title={primaryActionTitle}
          >
            {primaryActionLabel}
          </button>
          {suggestion.isSafe !== false && (
            <>
              <button
                type="button"
                className="settings-inline-upgrade-action"
                onClick={() => {
                  setModelUpgradePolicy(target.key, 'auto');
                  applySuggestionToTarget();
                }}
                title={`Always auto-switch future turns from ${suggestion.currentModel} to ${suggestion.suggestedModel} for ${target.label}.`}
              >
                Auto-switch
              </button>
            </>
          )}
          <button
            type="button"
            className="settings-inline-upgrade-action"
            onClick={() => dismissModelUpgrade(suggestion)}
            title="Hide this upgrade notice until a different newer version appears."
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  };
  const currentPresetSnapshot = useMemo(() => ({
    models,
    synthesizerModel: normalizeModelForProvider(synthProvider, synth) || synth,
    convergenceModel: normalizeModelForProvider(convProvider, convModel) || convModel,
    maxDebateRounds: Number.isFinite(Number(maxRounds)) ? Number(maxRounds) : 0,
    webSearchModel: normalizeModelForProvider(searchProvider, searchModel) || searchModel,
  }), [models, synthProvider, synth, convProvider, convModel, maxRounds, searchProvider, searchModel]);
  const savedSettingsPresetSnapshot = useMemo(() => ({
    models: selectedModels,
    synthesizerModel,
    convergenceModel,
    maxDebateRounds: Number.isFinite(Number(maxDebateRounds)) ? Number(maxDebateRounds) : 0,
    webSearchModel,
  }), [selectedModels, synthesizerModel, convergenceModel, maxDebateRounds, webSearchModel]);
  const selectedPreset = useMemo(
    () => modelPresets.find((preset) => preset.id === selectedPresetId) || null,
    [modelPresets, selectedPresetId]
  );
  const activePresetMatch = useMemo(
    () => modelPresets.find((preset) => presetMatchesDraft(preset, currentPresetSnapshot)) || null,
    [modelPresets, currentPresetSnapshot]
  );
  const selectedPresetIsModified = useMemo(
    () => (selectedPreset ? !presetMatchesDraft(selectedPreset, currentPresetSnapshot) : false),
    [selectedPreset, currentPresetSnapshot]
  );
  const trimmedPresetNameInput = String(presetNameInput || '').trim();
  const selectedPresetNameChanged = selectedPreset
    ? trimmedPresetNameInput !== String(selectedPreset.name || '').trim()
    : false;
  const selectedPresetHasUnsavedChanges = Boolean(
    selectedPreset && (selectedPresetIsModified || selectedPresetNameChanged)
  );
  const canCreatePreset = !selectedPreset && Boolean(trimmedPresetNameInput);
  const canSaveSelectedPreset = Boolean(selectedPreset && trimmedPresetNameInput && selectedPresetHasUnsavedChanges);
  const presetStatusClassName = selectedPreset
    ? selectedPresetHasUnsavedChanges
      ? 'is-modified'
      : 'is-match'
    : 'is-custom';
  const presetStatusLabel = selectedPreset ? 'Loaded Preset' : 'New Preset Draft';
  let presetStatusMessage = activePresetMatch
    ? `Current settings match "${activePresetMatch.name}". Load that preset to edit it, or enter a new name to save a separate preset.`
    : 'Enter a name to save the current settings as a new preset.';
  if (selectedPreset && selectedPresetHasUnsavedChanges) {
    if (selectedPresetIsModified && activePresetMatch && activePresetMatch.id !== selectedPreset.id) {
      presetStatusMessage = `Current settings match "${activePresetMatch.name}" instead of "${selectedPreset.name}".`;
    } else if (selectedPresetNameChanged && !selectedPresetIsModified) {
      presetStatusMessage = `Rename "${selectedPreset.name}" and save when you're ready.`;
    } else {
      presetStatusMessage = `Adjustments to "${selectedPreset.name}" are ready to save.`;
    }
  } else if (selectedPreset) {
    presetStatusMessage = `"${selectedPreset.name}" is in sync with the current settings.`;
  }
  const presetDraftSummary = `${models.length} model${models.length === 1 ? '' : 's'}, ${maxRounds} round${Number(maxRounds) === 1 ? '' : 's'}`;
  const diagnosticsSummary = useMemo(() => {
    const callCount = Number(metrics?.callCount || 0);
    const successCount = Number(metrics?.successCount || 0);
    const failureCount = Number(metrics?.failureCount || 0);
    const retryAttempts = Number(metrics?.retryAttempts || 0);
    const retryRecovered = Number(metrics?.retryRecovered || 0);
    const promptCacheReadTokens = Math.max(0, Number(metrics?.promptCacheReadTokens || 0));
    const promptCacheWriteTokens = Math.max(0, Number(metrics?.promptCacheWriteTokens || 0));
    const promptCacheReadRequests = Math.max(0, Number(metrics?.promptCacheReadRequests || 0));
    const promptCacheWriteRequests = Math.max(0, Number(metrics?.promptCacheWriteRequests || 0));
    const samples = Array.isArray(metrics?.firstAnswerTimes) ? metrics.firstAnswerTimes : [];
    const avgFirstAnswerMs = samples.length > 0
      ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
      : null;
    const providerFailures = metrics?.failureByProvider && typeof metrics.failureByProvider === 'object'
      ? Object.entries(metrics.failureByProvider).sort((a, b) => b[1] - a[1])
      : [];

    return {
      hasData: callCount > 0 || failureCount > 0 || retryAttempts > 0 || promptCacheReadTokens > 0 || promptCacheWriteTokens > 0,
      totalCalls: callCount,
      successRate: callCount > 0 ? Math.round((successCount / callCount) * 100) : null,
      avgFirstAnswer: formatDurationCompact(avgFirstAnswerMs),
      retryRecovery: retryAttempts > 0 ? `${retryRecovered} of ${retryAttempts}` : 'No retries',
      promptCacheReads: formatTokenQuantity(promptCacheReadTokens),
      promptCacheWrites: formatTokenQuantity(promptCacheWriteTokens),
      promptCacheActivity: promptCacheReadRequests > 0 || promptCacheWriteRequests > 0
        ? `${promptCacheReadRequests} read / ${promptCacheWriteRequests} write`
        : 'No provider hits',
      topProviderFailure: providerFailures[0] || null,
    };
  }, [metrics]);
  const dirtyFilePreview = useMemo(
    () => formatFilePreview(appUpdateStatus?.dirtyEntries || []),
    [appUpdateStatus],
  );
  const updatedFilePreview = useMemo(
    () => formatFilePreview(appUpdateResult?.changedFiles || []),
    [appUpdateResult],
  );
  const settingsPanes = useMemo(() => ([
    { id: 'general', label: 'General', help: SETTINGS_PANE_HELP.general },
    { id: 'models', label: 'Models', help: SETTINGS_PANE_HELP.models },
    { id: 'reliability', label: 'Reliability', help: SETTINGS_PANE_HELP.reliability },
    { id: 'budget', label: 'Budget', help: SETTINGS_PANE_HELP.budget },
    { id: 'performance', label: 'Performance', help: SETTINGS_PANE_HELP.performance },
  ]), []);
  const setSettingsTargetRef = useCallback((targetKey, node) => {
    const normalizedKey = String(targetKey || '').trim();
    if (!normalizedKey) return;
    if (node) {
      settingsTargetRefs.current.set(normalizedKey, node);
      return;
    }
    settingsTargetRefs.current.delete(normalizedKey);
  }, []);
  const getSettingsTargetClassName = useCallback((baseClassName, targetKey) => {
    const normalizedKey = String(targetKey || '').trim();
    return [
      baseClassName,
      'settings-scroll-target',
      normalizedKey && normalizedKey === focusedSettingsTargetKey ? 'is-focused' : '',
    ].filter(Boolean).join(' ');
  }, [focusedSettingsTargetKey]);
  const appUpdateFollowUp = useMemo(() => {
    if (!appUpdateResult) return null;
    if (appUpdateResult.localChangesRequireManualRestore) {
      const manualRestoreMessage = appUpdateResult.stashRef
        ? `The app updated, but your local changes were saved in ${appUpdateResult.stashRef}. Reapply them manually if you still need them.`
        : 'The app updated, but your local changes were not reapplied automatically. Restore them manually if you still need them.';
      return {
        tone: 'warning',
        title: 'Manual Restore Required',
        description: appUpdateResult.restartRequired
          ? `${manualRestoreMessage} Restart this app on this machine after restoring anything you still need.`
          : manualRestoreMessage,
        allowReload: false,
        allowRestart: Boolean(appUpdateResult.restartRequired),
      };
    }
    if (appUpdateResult.restartRequired) {
      return {
        tone: 'warning',
        title: 'Restart Required',
        description: 'The update changed backend code or dependencies. Restart this app or the local backend process on this machine to finish loading it.',
        allowReload: false,
        allowRestart: true,
      };
    }
    if (appUpdateResult.reloadRecommended) {
      return {
        tone: 'info',
        title: 'Reload Recommended',
        description: 'Frontend files changed. Reload the UI now if it does not refresh automatically.',
        allowReload: true,
        allowRestart: false,
      };
    }
    if (appUpdateResult.updated) {
      return {
        tone: 'success',
        title: 'Update Complete',
        description: 'The latest app version is installed and no restart should be required.',
        allowReload: false,
        allowRestart: false,
      };
    }
    return null;
  }, [appUpdateResult]);

  const loadAppUpdateStatus = useCallback(async ({ refresh = true, clearResult = false } = {}) => {
    const requestId = appUpdateRequestIdRef.current + 1;
    appUpdateRequestIdRef.current = requestId;
    setAppUpdateState('loading');
    setAppUpdateError('');
    if (clearResult) {
      setAppUpdateResult(null);
      setAppUpdateRestartSheetOpen(false);
    }

    try {
      const status = await fetchAppUpdateStatus({ refresh });
      if (appUpdateRequestIdRef.current !== requestId) return null;
      setAppUpdateStatus(status);
      setAppUpdateState('ready');
      return status;
    } catch (error) {
      if (appUpdateRequestIdRef.current !== requestId) return null;
      setAppUpdateError(error?.message || 'Unable to check for app updates.');
      setAppUpdateState('error');
      return null;
    }
  }, []);

  const handleApplyAppUpdate = useCallback(async () => {
    appUpdateRequestIdRef.current += 1;
    setAppUpdateState('updating');
    setAppUpdateError('');
    setAppUpdateResult(null);
    setAppUpdateRestartSheetOpen(false);

    try {
      const result = await requestAppUpdate();
      setAppUpdateResult(result);
      if (result?.status) {
        setAppUpdateStatus(result.status);
      }

      if (result?.restartRequired && !result?.localChangesRequireManualRestore) {
        setAppUpdateState('ready');
        setAppUpdateRestartSheetOpen(true);
        return;
      }

      setAppUpdateState('ready');
    } catch (error) {
      setAppUpdateError(error?.message || 'Unable to apply the app update.');
      setAppUpdateState('error');
      try {
        const fallbackStatus = await fetchAppUpdateStatus({ refresh: false });
        setAppUpdateStatus(fallbackStatus);
      } catch {
        // keep the original updater error visible
      }
    }
  }, []);

  const handleReloadUi = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.location.reload();
  }, []);

  const getDirectProviderFromValue = (value) => {
    if (!value) return 'openrouter';
    if (value.includes(':')) return value.split(':')[0];
    return 'openrouter';
  };

  const buildProviderValue = (providerId, value) => {
    if (!value) return '';
    return providerId === 'openrouter' ? value : `${providerId}:${value}`;
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyInput(keyInput.trim());
    }, 240);
    return () => clearTimeout(timer);
  }, [keyInput]);

  useEffect(() => {
    synthEditingRef.current = false;
    convEditingRef.current = false;
    searchEditingRef.current = false;
  }, [showSettings]);

  useEffect(() => () => {
    if (settingsTargetHighlightTimeoutRef.current) {
      window.clearTimeout(settingsTargetHighlightTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!showSettings) {
      setFocusedSettingsTargetKey('');
    }
  }, [showSettings]);

  useEffect(() => {
    if (!focusedSettingsTargetKey) return undefined;
    if (settingsTargetHighlightTimeoutRef.current) {
      window.clearTimeout(settingsTargetHighlightTimeoutRef.current);
    }
    settingsTargetHighlightTimeoutRef.current = window.setTimeout(() => {
      setFocusedSettingsTargetKey('');
    }, 2200);
    return () => {
      if (settingsTargetHighlightTimeoutRef.current) {
        window.clearTimeout(settingsTargetHighlightTimeoutRef.current);
        settingsTargetHighlightTimeoutRef.current = 0;
      }
    };
  }, [focusedSettingsTargetKey]);

  useEffect(() => {
    if (!showSettings || !pendingSettingsFocus) return undefined;
    const nextPane = String(pendingSettingsFocus.pane || 'models').trim() || 'models';
    if (activeSettingsPane !== nextPane) {
      setActiveSettingsPane(nextPane);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const targetKey = String(pendingSettingsFocus.targetKey || '').trim();
      const targetNode = targetKey ? settingsTargetRefs.current.get(targetKey) : null;

      if (targetNode) {
        targetNode.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        targetNode.focus?.({ preventScroll: true });
        setFocusedSettingsTargetKey(targetKey);
      } else {
        settingsBodyRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
      }

      dispatch({ type: 'SET_PENDING_SETTINGS_FOCUS', payload: null });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [activeSettingsPane, dispatch, pendingSettingsFocus, showSettings]);

  useEffect(() => {
    if (!showSettings) return undefined;

    loadAppUpdateStatus({ refresh: true, clearResult: true });

    return () => {
      appUpdateRequestIdRef.current += 1;
    };
  }, [showSettings, loadAppUpdateStatus]);

  useEffect(() => {
    if (!providerOptions.find(p => p.id === newModelProvider) && providerOptions.length > 0) {
      setNewModelProvider(providerOptions[0].id);
    }
  }, [providerOptions, newModelProvider]);

  useEffect(() => {
    if (!showSettings) {
      presetSelectionInitializedRef.current = false;
      return;
    }

    const wasInitialized = presetSelectionInitializedRef.current;
    presetSelectionInitializedRef.current = true;

    setSelectedPresetId((current) => {
      return resolvePresetSelection({
        currentPresetId: current,
        initialized: wasInitialized,
        modelPresets,
        rememberedPresetId: loadLastModelPresetId(),
        savedSettingsSnapshot: savedSettingsPresetSnapshot,
      });
    });
  }, [showSettings, modelPresets, savedSettingsPresetSnapshot]);

  useEffect(() => {
    if (!showSettings) {
      presetEditorScopeRef.current = '';
      return;
    }

    const scopeKey = selectedPreset
      ? `preset:${selectedPreset.id}:${selectedPreset.name}`
      : 'custom:new';

    if (presetEditorScopeRef.current === scopeKey) return;
    presetEditorScopeRef.current = scopeKey;

    if (selectedPreset) {
      setPresetNameInput(selectedPreset.name);
      return;
    }

    setPresetNameInput('');
  }, [showSettings, selectedPreset]);

  useEffect(() => {
    if (!presetSheet?.requiresValue) return;
    const timer = setTimeout(() => {
      presetSheetInputRef.current?.focus();
      presetSheetInputRef.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, [presetSheet]);

  useEffect(() => {
    if (!presetSheet && !appUpdateRestartSheetOpen) return;
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (presetSheet) {
        setPresetSheet(null);
        setPresetSheetValue('');
        return;
      }
      setAppUpdateRestartSheetOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [presetSheet, appUpdateRestartSheetOpen]);

  const coerceDirectModelToOpenRouter = (value) => {
    if (!value || !value.includes(':')) return value;
    const [prefix, rest] = value.split(':');
    const mapped = prefix === 'gemini' ? 'google' : prefix;
    return rest ? `${mapped}/${rest}` : value;
  };

  useEffect(() => {
    if (providerOptions.length === 0) return;
    const enabledIds = providerOptions.map(p => p.id);
    const nextProvider = (current) => (enabledIds.includes(current) ? current : enabledIds[0]);

    const resolvedSynthProvider = nextProvider(synthProvider);
    if (resolvedSynthProvider !== synthProvider) {
      setSynthProvider(resolvedSynthProvider);
      if (resolvedSynthProvider === 'openrouter') {
        setSynth(coerceDirectModelToOpenRouter(synth));
      }
    }

    const resolvedConvProvider = nextProvider(convProvider);
    if (resolvedConvProvider !== convProvider) {
      setConvProvider(resolvedConvProvider);
      if (resolvedConvProvider === 'openrouter') {
        setConvModel(coerceDirectModelToOpenRouter(convModel));
      }
    }

    const resolvedSearchProvider = nextProvider(searchProvider);
    if (resolvedSearchProvider !== searchProvider) {
      setSearchProvider(resolvedSearchProvider);
      if (resolvedSearchProvider === 'openrouter') {
        setSearchModel(coerceDirectModelToOpenRouter(searchModel));
      }
    }
  }, [providerOptions, synthProvider, convProvider, searchProvider, synth, convModel, searchModel]);

  const removeModel = (index) => {
    if (models.length <= 1) return;
    setModels(models.filter((_, i) => i !== index));
  };

  const applyRankedTopModels = (count = 3) => {
    if (!Array.isArray(rankedModels) || rankedModels.length === 0) return;
    const top = selectDiverseModels({
      rankedModels,
      count: Math.max(1, count),
    }).map((entry) => entry.modelId);
    if (top.length > 0) {
      setModels(top);
    }
  };

  const closePresetSheet = () => {
    setPresetSheet(null);
    setPresetSheetValue('');
  };

  const closeAppUpdateRestartSheet = () => {
    setAppUpdateRestartSheetOpen(false);
  };

  const handleConfirmAppRestart = useCallback(async () => {
    setAppUpdateRestartSheetOpen(false);
    setAppUpdateState('restarting');
    setAppUpdateError('');
    try {
      const restartResult = await requestAppRestart();
      await waitForAppRestart({
        previousPid: restartResult?.pid ?? null,
        previousStartedAt: restartResult?.startedAt ?? null,
      });
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (error) {
      setAppUpdateError(error?.message || 'The update finished, but automatic restart failed. Restart the app manually.');
      setAppUpdateState('error');
    }
  }, []);

  const loadPresetValues = (preset) => {
    if (!preset?.models?.length) return;
    setModels([...preset.models]);
    if (preset.synthesizerModel) setSynth(preset.synthesizerModel);
    if (preset.convergenceModel) setConvModel(preset.convergenceModel);
    if (preset.maxDebateRounds) setMaxRounds(preset.maxDebateRounds);
    if (preset.webSearchModel) setSearchModel(preset.webSearchModel);
    if (preset.synthesizerModel) setSynthProvider(getDirectProviderFromValue(preset.synthesizerModel));
    if (preset.convergenceModel) setConvProvider(getDirectProviderFromValue(preset.convergenceModel));
    if (preset.webSearchModel) setSearchProvider(getDirectProviderFromValue(preset.webSearchModel));
  };

  const applyPreset = (preset) => {
    if (!preset) return;
    loadPresetValues(preset);
    setSelectedPresetId(preset.id);
    setPresetNameInput(preset.name || '');
    presetEditorScopeRef.current = '';
    saveLastModelPresetId(preset.id);
  };

  const startNewPresetDraft = () => {
    setSelectedPresetId('');
    setPresetNameInput('');
    presetEditorScopeRef.current = '';
    closePresetSheet();
  };

  const handlePresetSelection = (event) => {
    const nextId = event.target.value;
    if (!nextId) {
      startNewPresetDraft();
      return;
    }
    const preset = modelPresets.find((entry) => entry.id === nextId);
    if (preset) {
      applyPreset(preset);
    } else {
      setSelectedPresetId(nextId);
    }
  };

  const suggestPresetCopyName = () => {
    if (selectedPreset) {
      if (trimmedPresetNameInput && trimmedPresetNameInput.toLowerCase() !== String(selectedPreset.name || '').trim().toLowerCase()) {
        return buildUniquePresetName(trimmedPresetNameInput, modelPresets);
      }
      return buildUniquePresetName(`${selectedPreset.name} Copy`, modelPresets);
    }
    if (trimmedPresetNameInput) return buildUniquePresetName(trimmedPresetNameInput, modelPresets);
    if (activePresetMatch?.name) return buildUniquePresetName(`${activePresetMatch.name} Copy`, modelPresets);
    return buildUniquePresetName('New Preset', modelPresets);
  };

  const resetPresetNameDraft = () => {
    if (selectedPreset) {
      setPresetNameInput(selectedPreset.name);
      return;
    }
    setPresetNameInput(suggestPresetCopyName());
  };

  const handleCreatePreset = () => {
    if (!trimmedPresetNameInput) return;
    const uniqueName = buildUniquePresetName(trimmedPresetNameInput, modelPresets);
    const payload = buildPresetPayload(uniqueName);
    if (!payload) return;
    const nextId = createPresetId();
    dispatch({
      type: 'ADD_MODEL_PRESET',
      payload: {
        id: nextId,
        ...payload,
      },
    });
    setSelectedPresetId(nextId);
    setPresetNameInput(payload.name);
    presetEditorScopeRef.current = '';
    saveLastModelPresetId(nextId);
  };

  const handleSavePresetEdits = () => {
    if (!selectedPreset || !trimmedPresetNameInput) return;
    const uniqueName = buildUniquePresetName(trimmedPresetNameInput, modelPresets, selectedPreset.id);
    const payload = buildPresetPayload(uniqueName);
    if (!payload) return;
    dispatch({
      type: 'UPDATE_MODEL_PRESET',
      payload: {
        id: selectedPreset.id,
        ...payload,
      },
    });
    setPresetNameInput(payload.name);
    saveLastModelPresetId(selectedPreset.id);
  };

  const handleRevertPreset = () => {
    if (!selectedPreset) {
      resetPresetNameDraft();
      return;
    }
    loadPresetValues(selectedPreset);
    setPresetNameInput(selectedPreset.name);
  };

  const openSaveAsPresetSheet = () => {
    setPresetSheet({
      mode: 'save-as',
      title: 'Save as New Preset',
      confirmLabel: 'Create Preset',
      description: 'Create a separate preset from the current settings without changing the loaded preset.',
      requiresValue: true,
    });
    setPresetSheetValue(suggestPresetCopyName());
  };

  const openDeletePresetSheet = () => {
    if (!selectedPreset) return;
    setPresetSheet({
      mode: 'delete',
      title: 'Delete Preset',
      confirmLabel: 'Delete',
      description: `Delete "${selectedPreset.name}"? This cannot be undone.`,
      requiresValue: false,
      destructive: true,
    });
    setPresetSheetValue('');
  };

  const submitPresetSheet = () => {
    if (!presetSheet) return;

    if (presetSheet.mode === 'save-as') {
      const trimmedName = String(presetSheetValue || '').trim();
      if (!trimmedName) return;
      const uniqueName = buildUniquePresetName(trimmedName, modelPresets);
      const payload = buildPresetPayload(uniqueName);
      if (!payload) return;
      const nextId = createPresetId();
      dispatch({
        type: 'ADD_MODEL_PRESET',
        payload: {
          id: nextId,
          ...payload,
        },
      });
      setSelectedPresetId(nextId);
      setPresetNameInput(payload.name);
      presetEditorScopeRef.current = '';
      saveLastModelPresetId(nextId);
      closePresetSheet();
      return;
    }

    if (presetSheet.mode === 'delete') {
      if (!selectedPreset) return;
      dispatch({ type: 'DELETE_MODEL_PRESET', payload: selectedPreset.id });
      setSelectedPresetId('');
      setPresetNameInput('');
      presetEditorScopeRef.current = '';
      saveLastModelPresetId('');
      closePresetSheet();
    }
  };

  const resetDefaults = () => {
    setModels(DEFAULT_DEBATE_MODELS);
    setSynth(DEFAULT_SYNTHESIZER_MODEL);
    setConvModel(DEFAULT_CONVERGENCE_MODEL);
    setConvOnFinalRound(DEFAULT_CONVERGENCE_ON_FINAL_ROUND);
    setMaxRounds(DEFAULT_MAX_DEBATE_ROUNDS);
    setSearchModel(DEFAULT_WEB_SEARCH_MODEL);
    setStrictSearch(false);
    setRetryMaxAttempts(DEFAULT_RETRY_POLICY.maxAttempts);
    setRetryBaseDelayMs(DEFAULT_RETRY_POLICY.baseDelayMs);
    setRetryMaxDelayMs(DEFAULT_RETRY_POLICY.maxDelayMs);
    setCircuitFailureThreshold(DEFAULT_RETRY_POLICY.circuitFailureThreshold);
    setCircuitCooldownMs(DEFAULT_RETRY_POLICY.circuitCooldownMs);
    setBudgetEnabled(false);
    setBudgetSoftLimit(1.5);
    setBudgetAutoApprove(0.5);
    setRankingMode('balanced');
    setRankingPreferFlagship(true);
    setRankingPreferNew(true);
    setRankingAllowPreview(true);
    setUpgradeNotificationsEnabled(true);
    setVirtualizationEnabled(true);
    setVirtualizationKeepLatest(4);
    setCachePersistence(true);
    setPromptCacheEnabled(DEFAULT_PROMPT_CACHE_POLICY.enabled);
    setPromptCacheClaudeTtl(DEFAULT_PROMPT_CACHE_POLICY.claudeTtl);
    setPromptCacheOpenAIRetention(DEFAULT_PROMPT_CACHE_POLICY.openaiRetention);
    setPromptCacheGeminiExplicit(DEFAULT_PROMPT_CACHE_POLICY.geminiExplicit);
    setPromptCacheGeminiTtlSeconds(DEFAULT_PROMPT_CACHE_POLICY.geminiTtlSeconds);
    setPromptCacheWarmupSerialization(DEFAULT_PROMPT_CACHE_POLICY.warmupSerialization);
    setThemeSelection(DEFAULT_THEME_MODE);
  };

  useEffect(() => {
    if (!showSettings) return;
    liveApplyReadyRef.current = false;
    setKeyInput(apiKey);
    setModels(selectedModels);
    if (!synthEditingRef.current) setSynth(synthesizerModel);
    if (!convEditingRef.current) setConvModel(convergenceModel);
    setConvOnFinalRound(Boolean(convergenceOnFinalRound));
    setMaxRounds(maxDebateRounds);
    if (!searchEditingRef.current) setSearchModel(webSearchModel);
    setStrictSearch(strictWebSearch);
    setRetryMaxAttempts(retryPolicy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts);
    setRetryBaseDelayMs(retryPolicy?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs);
    setRetryMaxDelayMs(retryPolicy?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs);
    setCircuitFailureThreshold(retryPolicy?.circuitFailureThreshold ?? DEFAULT_RETRY_POLICY.circuitFailureThreshold);
    setCircuitCooldownMs(retryPolicy?.circuitCooldownMs ?? DEFAULT_RETRY_POLICY.circuitCooldownMs);
    setBudgetEnabled(Boolean(budgetGuardrailsEnabled));
    setBudgetSoftLimit(Number(budgetSoftLimitUsd || 0));
    setBudgetAutoApprove(Number(budgetAutoApproveBelowUsd || 0));
    setRankingMode(smartRankingMode || 'balanced');
    setRankingPreferFlagship(Boolean(smartRankingPreferFlagship));
    setRankingPreferNew(Boolean(smartRankingPreferNew));
    setRankingAllowPreview(Boolean(smartRankingAllowPreview));
    setUpgradeNotificationsEnabled(Boolean(modelUpgradeNotificationsEnabled));
    setVirtualizationEnabled(Boolean(streamVirtualizationEnabled));
    setVirtualizationKeepLatest(Number(streamVirtualizationKeepLatest || 4));
    setCachePersistence(Boolean(cachePersistenceEnabled));
    const normalizedPromptCachePolicy = normalizePromptCachePolicy(promptCachePolicy);
    setPromptCacheEnabled(Boolean(normalizedPromptCachePolicy.enabled));
    setPromptCacheClaudeTtl(normalizedPromptCachePolicy.claudeTtl);
    setPromptCacheOpenAIRetention(normalizedPromptCachePolicy.openaiRetention);
    setPromptCacheGeminiExplicit(Boolean(normalizedPromptCachePolicy.geminiExplicit));
    setPromptCacheGeminiTtlSeconds(Number(normalizedPromptCachePolicy.geminiTtlSeconds));
    setPromptCacheWarmupSerialization(Boolean(normalizedPromptCachePolicy.warmupSerialization));
    setThemeSelection(themeMode || DEFAULT_THEME_MODE);
    setRememberKey(rememberApiKey);
    setDebouncedKeyInput(apiKey.trim());
    closePresetSheet();
    if (!synthEditingRef.current) setSynthProvider(getDirectProviderFromValue(synthesizerModel));
    if (!convEditingRef.current) setConvProvider(getDirectProviderFromValue(convergenceModel));
    if (!searchEditingRef.current) setSearchProvider(getDirectProviderFromValue(webSearchModel));
    const timer = setTimeout(() => {
      liveApplyReadyRef.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [
    showSettings,
    apiKey,
    selectedModels,
    synthesizerModel,
    convergenceModel,
    convergenceOnFinalRound,
    maxDebateRounds,
    webSearchModel,
    strictWebSearch,
    retryPolicy,
    budgetGuardrailsEnabled,
    budgetSoftLimitUsd,
    budgetAutoApproveBelowUsd,
    smartRankingMode,
    smartRankingPreferFlagship,
    smartRankingPreferNew,
    smartRankingAllowPreview,
    modelUpgradeNotificationsEnabled,
    streamVirtualizationEnabled,
    streamVirtualizationKeepLatest,
    cachePersistenceEnabled,
    promptCachePolicy,
    themeMode,
    rememberApiKey,
  ]);

  const handlePresetNameKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (selectedPreset) {
      if (canSaveSelectedPreset) handleSavePresetEdits();
      return;
    }
    if (canCreatePreset) {
      handleCreatePreset();
    }
  };

  useEffect(() => {
    if (!showSettings || !liveApplyReadyRef.current) return;

    if (rememberKey !== rememberApiKey) {
      dispatch({ type: 'SET_REMEMBER_API_KEY', payload: rememberKey });
    }
    if (debouncedKeyInput !== apiKey) {
      dispatch({ type: 'SET_API_KEY', payload: debouncedKeyInput });
    }
    if (!arraysEqual(models, selectedModels)) {
      dispatch({ type: 'SET_MODELS', payload: models });
    }
    if (!synthEditingRef.current && normalizedSynthValue !== synthesizerModel) {
      dispatch({ type: 'SET_SYNTHESIZER', payload: normalizedSynthValue });
    }
    if (!convEditingRef.current && normalizedConvergenceValue !== convergenceModel) {
      dispatch({ type: 'SET_CONVERGENCE_MODEL', payload: normalizedConvergenceValue });
    }
    if (Boolean(convOnFinalRound) !== Boolean(convergenceOnFinalRound)) {
      dispatch({ type: 'SET_CONVERGENCE_ON_FINAL_ROUND', payload: convOnFinalRound });
    }
    if (Number(maxRounds) !== Number(maxDebateRounds)) {
      dispatch({ type: 'SET_MAX_DEBATE_ROUNDS', payload: maxRounds });
    }
    if (!searchEditingRef.current && normalizedSearchValue !== webSearchModel) {
      dispatch({ type: 'SET_WEB_SEARCH_MODEL', payload: normalizedSearchValue });
    }
    if (Boolean(strictSearch) !== Boolean(strictWebSearch)) {
      dispatch({ type: 'SET_STRICT_WEB_SEARCH', payload: strictSearch });
    }
    if (!retryPoliciesEqual(draftRetryPolicy, retryPolicy)) {
      dispatch({ type: 'SET_RETRY_POLICY', payload: draftRetryPolicy });
    }
    if (Boolean(budgetEnabled) !== Boolean(budgetGuardrailsEnabled)) {
      dispatch({ type: 'SET_BUDGET_GUARDRAILS_ENABLED', payload: budgetEnabled });
    }
    if (Number(budgetSoftLimit) !== Number(budgetSoftLimitUsd)) {
      dispatch({ type: 'SET_BUDGET_SOFT_LIMIT_USD', payload: budgetSoftLimit });
    }
    if (Number(budgetAutoApprove) !== Number(budgetAutoApproveBelowUsd)) {
      dispatch({ type: 'SET_BUDGET_AUTO_APPROVE_BELOW_USD', payload: budgetAutoApprove });
    }
    if (rankingMode !== smartRankingMode) {
      dispatch({ type: 'SET_SMART_RANKING_MODE', payload: rankingMode });
    }
    if (Boolean(rankingPreferFlagship) !== Boolean(smartRankingPreferFlagship)) {
      dispatch({ type: 'SET_SMART_RANKING_PREFER_FLAGSHIP', payload: rankingPreferFlagship });
    }
    if (Boolean(rankingPreferNew) !== Boolean(smartRankingPreferNew)) {
      dispatch({ type: 'SET_SMART_RANKING_PREFER_NEW', payload: rankingPreferNew });
    }
    if (Boolean(rankingAllowPreview) !== Boolean(smartRankingAllowPreview)) {
      dispatch({ type: 'SET_SMART_RANKING_ALLOW_PREVIEW', payload: rankingAllowPreview });
    }
    if (Boolean(upgradeNotificationsEnabled) !== Boolean(modelUpgradeNotificationsEnabled)) {
      dispatch({ type: 'SET_MODEL_UPGRADE_NOTIFICATIONS_ENABLED', payload: upgradeNotificationsEnabled });
    }
    if (Boolean(virtualizationEnabled) !== Boolean(streamVirtualizationEnabled)) {
      dispatch({ type: 'SET_STREAM_VIRTUALIZATION_ENABLED', payload: virtualizationEnabled });
    }
    if (Number(virtualizationKeepLatest) !== Number(streamVirtualizationKeepLatest)) {
      dispatch({ type: 'SET_STREAM_VIRTUALIZATION_KEEP_LATEST', payload: virtualizationKeepLatest });
    }
    if (Boolean(cachePersistence) !== Boolean(cachePersistenceEnabled)) {
      dispatch({ type: 'SET_CACHE_PERSISTENCE_ENABLED', payload: cachePersistence });
    }
    if (!promptCachePoliciesEqual(draftPromptCachePolicy, promptCachePolicy)) {
      dispatch({ type: 'SET_PROMPT_CACHE_POLICY', payload: draftPromptCachePolicy });
    }
    if (themeSelection !== themeMode) {
      dispatch({ type: 'SET_THEME_MODE', payload: themeSelection });
    }
  }, [
    showSettings,
    rememberKey,
    rememberApiKey,
    debouncedKeyInput,
    apiKey,
    models,
    selectedModels,
    normalizedSynthValue,
    synthesizerModel,
    normalizedConvergenceValue,
    convergenceModel,
    convOnFinalRound,
    convergenceOnFinalRound,
    maxRounds,
    maxDebateRounds,
    normalizedSearchValue,
    webSearchModel,
    strictSearch,
    strictWebSearch,
    draftRetryPolicy,
    retryPolicy,
    budgetEnabled,
    budgetGuardrailsEnabled,
    budgetSoftLimit,
    budgetSoftLimitUsd,
    budgetAutoApprove,
    budgetAutoApproveBelowUsd,
    rankingMode,
    smartRankingMode,
    rankingPreferFlagship,
    smartRankingPreferFlagship,
    rankingPreferNew,
    smartRankingPreferNew,
    rankingAllowPreview,
    smartRankingAllowPreview,
    upgradeNotificationsEnabled,
    modelUpgradeNotificationsEnabled,
    virtualizationEnabled,
    streamVirtualizationEnabled,
    virtualizationKeepLatest,
    streamVirtualizationKeepLatest,
    cachePersistence,
    cachePersistenceEnabled,
    draftPromptCachePolicy,
    promptCachePolicy,
    themeSelection,
    themeMode,
    dispatch,
  ]);

  const synthUpgradeTarget = getInlineModelUpgradeTarget('synth');
  const convergenceUpgradeTarget = getInlineModelUpgradeTarget('convergence');
  const searchUpgradeTarget = getInlineModelUpgradeTarget('search');

  if (!showSettings) return null;

  return (
    <div className="settings-overlay" onClick={handleClose}>
      <div className="settings-modal glass-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={handleClose} title="Close settings">
            <X size={18} />
          </button>
        </div>

        <div className="settings-body" ref={settingsBodyRef}>
          <div className="settings-pane-tabs" role="tablist" aria-label="Settings sections">
            {settingsPanes.map((pane) => (
              <button
                key={pane.id}
                type="button"
                role="tab"
                aria-selected={activeSettingsPane === pane.id}
                aria-label={`${pane.label}. ${pane.help}`}
                className={`settings-pane-tab ${activeSettingsPane === pane.id ? 'active' : ''}`}
                onClick={() => setActiveSettingsPane(pane.id)}
                title={pane.help}
              >
                <span className="settings-pane-tab-copy">
                  <span>{pane.label}</span>
                </span>
              </button>
            ))}
          </div>

          {activeSettingsPane === 'general' && (
            <>
          <div className="settings-section">
            <label className="settings-label">
              <Key size={14} />
              <span className="settings-label-copy">
                <span>OpenRouter API Key (optional override)</span>
                <InfoTip
                  label="OpenRouter API key help"
                  content={[
                    'This key overrides the server default for requests from this browser profile.',
                    'Leave it blank if your backend already injects credentials.',
                    'If you save it locally, it stays on this device until you remove it.',
                  ]}
                />
              </span>
            </label>
            <input
              type="password"
              className="settings-input"
              placeholder="sk-or-... (optional)"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              autoFocus={!apiKey}
              title="Optional browser-side OpenRouter override. Leave blank to keep using the backend default."
            />
            <label
              className="settings-checkbox"
              title="Store this override in browser storage on this machine. Turn it off on shared devices."
            >
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={e => setRememberKey(e.target.checked)}
              />
              <span className="settings-checkbox-copy">
                <span>Remember key on this device</span>
                <InfoTip
                  label="Remember key help"
                  content={[
                    'Saves the API key in this browser profile so you do not need to re-enter it.',
                    'Disable this on any shared or temporary machine.',
                  ]}
                />
              </span>
            </label>
            <p className="settings-hint">
              Server-side API keys are recommended. Optional OpenRouter override:{' '}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                openrouter.ai/keys
              </a>
            </p>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Sun size={14} />
              <span className="settings-label-copy">
                <span>Theme</span>
                <InfoTip
                  label="Theme help"
                  content={[
                    'Switch between dark and light appearance modes for this app.',
                    'The choice applies immediately and is saved only on this device.',
                  ]}
                />
              </span>
            </label>
            <select
              className="settings-input settings-select"
              value={themeSelection}
              onChange={e => setThemeSelection(e.target.value)}
              title="Choose the app appearance for this browser profile."
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
            <p className="settings-hint">
              Applies immediately and stays saved on this device.
            </p>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Download size={14} />
              <span className="settings-label-copy">
                <span>App Updates</span>
                <InfoTip
                  label="App updates help"
                  content={[
                    'Checks this local clone against its upstream branch.',
                    'Use it when you want to pull newer code into the app without leaving the UI.',
                    'If backend files or dependencies change, you may need to restart the local app afterward.',
                  ]}
                />
              </span>
            </label>
            <div className="settings-update-card">
              <div className="settings-update-grid">
                <div className="settings-update-item">
                  <span className="settings-update-item-label">Version</span>
                  <strong className="settings-update-item-value">{appUpdateStatus?.currentVersion || '--'}</strong>
                </div>
                <div className="settings-update-item">
                  <span className="settings-update-item-label">Branch</span>
                  <code className="settings-update-code">{appUpdateStatus?.branch || '--'}</code>
                </div>
                <div className="settings-update-item">
                  <span className="settings-update-item-label">Commit</span>
                  <code className="settings-update-code">{appUpdateStatus?.currentCommitShort || '--'}</code>
                </div>
                <div className="settings-update-item">
                  <span className="settings-update-item-label">Remote</span>
                  <code className="settings-update-code">{appUpdateStatus?.upstream || 'Not configured'}</code>
                </div>
              </div>

              <p className="settings-hint">
                {appUpdateResult?.summary || appUpdateStatus?.statusMessage || 'Check this clone against its upstream branch.'}
              </p>

              {appUpdateStatus?.checkError && (
                <p className="settings-update-alert">
                  Remote check warning: {appUpdateStatus.checkError}
                </p>
              )}

              {appUpdateError && (
                <p className="settings-update-alert is-error">{appUpdateError}</p>
              )}

              {dirtyFilePreview && (
                <p className="settings-hint">
                  Local changes: <code>{dirtyFilePreview}</code>
                </p>
              )}

              {updatedFilePreview && (
                <p className="settings-hint">
                  Updated files: <code>{updatedFilePreview}</code>
                </p>
              )}

              {appUpdateFollowUp && (
                <div className={`settings-update-followup ${appUpdateFollowUp.tone}`}>
                  <div className="settings-update-followup-copy">
                    <strong>{appUpdateFollowUp.title}</strong>
                    <span>{appUpdateFollowUp.description}</span>
                  </div>
                  {appUpdateFollowUp.allowReload && (
                    <button
                      className="settings-btn-secondary"
                      type="button"
                      onClick={handleReloadUi}
                      title="Reload the frontend so the newly pulled UI files are used immediately."
                    >
                      Reload UI
                    </button>
                  )}
                  {appUpdateFollowUp.allowRestart && (
                    <button
                      className="settings-btn-secondary"
                      type="button"
                      onClick={() => setAppUpdateRestartSheetOpen(true)}
                      disabled={appUpdateState === 'restarting'}
                      title="Open the in-app restart confirmation for this machine."
                    >
                      {appUpdateState === 'restarting' ? 'Restarting...' : 'Restart App'}
                    </button>
                  )}
                </div>
              )}

              <div className="settings-update-actions">
                <button
                  className="settings-btn-secondary"
                  type="button"
                  onClick={() => loadAppUpdateStatus({ refresh: true, clearResult: true })}
                  disabled={appUpdateState === 'loading' || appUpdateState === 'updating' || appUpdateState === 'restarting'}
                  title="Fetch the latest upstream status without applying any changes."
                >
                  {appUpdateState === 'loading' ? 'Checking...' : 'Check for Updates'}
                </button>
                <button
                  className="settings-btn-primary"
                  type="button"
                  onClick={handleApplyAppUpdate}
                  disabled={appUpdateState === 'loading' || appUpdateState === 'updating' || appUpdateState === 'restarting' || !appUpdateStatus?.canUpdate}
                  title="Pull the newest code from the tracked branch into this local clone."
                >
                  {appUpdateState === 'restarting' ? 'Restarting...' : appUpdateState === 'updating' ? 'Updating...' : 'Update Now'}
                </button>
              </div>

              <p className="settings-hint">
                Runs <code>git pull --ff-only</code> and refreshes dependencies with <code>npm ci</code> only when package dependencies or the lockfile dependency graph changes. Ordinary local changes, including routine unstaged <code>package-lock.json</code> drift, are auto-stashed and restored; <code>package.json</code>, <code>npm-shrinkwrap.json</code>, staged lockfile edits, and unresolved conflicts still block updates.
              </p>
            </div>
          </div>

            </>
          )}

          {activeSettingsPane === 'models' && (
            <>
          <div className="settings-section">
            <label className="settings-label">
              <span className="settings-label-copy">
                <span>Model Presets</span>
                <InfoTip
                  label="Model presets help"
                  content={[
                    'Presets save the current debate roster plus the synthesis, convergence, search, and rounds settings below.',
                    'The loaded preset stays selected while you edit. Use New Preset when you want a separate draft.',
                  ]}
                />
              </span>
            </label>
            <div className="preset-selector-card">
              <div className="preset-picker-row">
                <label className="preset-inline-field">
                  <span className="settings-sub-label">Preset context</span>
                  <div className="preset-select-control">
                    <select
                      className="settings-input settings-select preset-selector-input"
                      value={selectedPresetId}
                      onChange={handlePresetSelection}
                      title="Load a saved model configuration. Choosing one applies it immediately."
                    >
                      <option value="">New preset draft</option>
                      {modelPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="settings-btn-secondary preset-new-button"
                      onClick={startNewPresetDraft}
                      title="Start a separate preset draft from the current settings."
                    >
                      <Plus size={14} />
                      New Preset
                    </button>
                  </div>
                </label>
                <div className={`preset-status ${presetStatusClassName}`}>
                  <span className="preset-status-label">{presetStatusLabel}</span>
                  <span className="preset-status-text">{presetStatusMessage}</span>
                </div>
              </div>

              <div className="preset-editor-card">
                <div className="preset-editor-header">
                  <div className="preset-editor-copy">
                    <span className="settings-sub-label">{selectedPreset ? 'Edit Loaded Preset' : 'Create New Preset'}</span>
                    <strong>{selectedPreset ? selectedPreset.name : 'New preset draft'}</strong>
                  </div>
                  <span className="preset-editor-summary">{presetDraftSummary}</span>
                </div>

                <label className="preset-inline-field">
                  <span className="settings-sub-label">{selectedPreset ? 'Preset name' : 'New preset name'}</span>
                  <input
                    type="text"
                    className="settings-input"
                    value={presetNameInput}
                    onChange={(event) => setPresetNameInput(event.target.value)}
                    onKeyDown={handlePresetNameKeyDown}
                    placeholder="Preset name"
                    title="Name for saving the current configuration as a reusable preset."
                  />
                </label>

                <div className="preset-action-row">
                  {selectedPreset ? (
                    <>
                      <button
                        type="button"
                        className="settings-btn-primary"
                        onClick={handleSavePresetEdits}
                        disabled={!canSaveSelectedPreset}
                        title="Overwrite the selected preset with the configuration currently shown below."
                      >
                        Update Preset
                      </button>
                      <button
                        type="button"
                        className="settings-btn-secondary"
                        onClick={handleRevertPreset}
                        disabled={!selectedPresetHasUnsavedChanges}
                        title="Discard unsaved preset edits and restore the last saved version."
                      >
                        Reset to Saved
                      </button>
                      <button
                        type="button"
                        className="settings-btn-secondary"
                        onClick={openSaveAsPresetSheet}
                        title="Save this draft as a new preset without changing the original."
                      >
                        Save as New...
                      </button>
                      <button
                        type="button"
                        className="settings-btn-danger"
                        onClick={openDeletePresetSheet}
                        title="Delete the currently selected preset from this browser profile."
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="settings-btn-primary"
                        onClick={handleCreatePreset}
                        disabled={!canCreatePreset}
                        title="Save the current models and supporting settings as a new preset."
                      >
                        Create New Preset
                      </button>
                      {activePresetMatch && (
                        <button
                          type="button"
                          className="settings-btn-secondary"
                          onClick={() => applyPreset(activePresetMatch)}
                          title={`Load "${activePresetMatch.name}" so changes update that saved preset.`}
                        >
                          Load Matching Preset
                        </button>
                      )}
                      <button
                        type="button"
                        className="settings-btn-secondary"
                        onClick={resetPresetNameDraft}
                        title="Generate a preset name from the current model lineup and round count."
                      >
                        Suggest Name
                      </button>
                    </>
                  )}
                </div>
              </div>

              <p className="settings-hint">
                Loaded presets stay selected while you tweak settings. Use New Preset when you want a separate preset instead of updating the loaded one.
              </p>
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Cpu size={14} />
              <span className="settings-label-copy">
                <span>Debate Models</span>
                <InfoTip
                  label="Debate models help"
                  content={[
                    'These are the models that produce the main responses in Debate and Parallel modes.',
                    'Add a mix of strengths if you want disagreement, or similar models if you want a tighter consensus.',
                    'The app uses the first round roster here unless a turn explicitly overrides it.',
                  ]}
                />
              </span>
            </label>
            <div className="settings-upgrade-toolbar">
              <label className="settings-checkbox" title="Show a banner or inline notice when a newer safe same-track model is available.">
                <input
                  type="checkbox"
                  checked={upgradeNotificationsEnabled}
                  onChange={(event) => setUpgradeNotificationsEnabled(event.target.checked)}
                />
                <span className="settings-checkbox-copy">
                  <span>Show upgrade notices</span>
                  <InfoTip
                    label="Upgrade notification help"
                    content={[
                      'Each model selector below has its own upgrade policy. Set it to pinned, notify, or auto-upgrade safe.',
                      'This toggle only controls visible notices. Auto-upgrade targets can still switch future turns automatically, while historical turns keep their original model IDs.',
                    ]}
                  />
                </span>
              </label>
              {dismissedModelUpgradeSuggestionCount > 0 && (
                <button
                  type="button"
                  className="settings-inline-upgrade-action"
                  onClick={resetDismissedModelUpgrades}
                  title="Show dismissed upgrade notices again."
                >
                  Reset dismissed
                </button>
              )}
            </div>
            <div className="model-list">
              {models.map((model, i) => {
                const upgradeTarget = getInlineModelUpgradeTarget('debate', model);
                return (
                  <div
                    key={i}
                    ref={(node) => setSettingsTargetRef(upgradeTarget?.key, node)}
                    data-settings-target-key={upgradeTarget?.key || undefined}
                    tabIndex={upgradeTarget?.key ? -1 : undefined}
                    className={getSettingsTargetClassName('model-item', upgradeTarget?.key)}
                  >
                    <div className="model-item-main">
                      <ModelStatsHoverCard
                        modelId={model}
                        modelCatalog={modelCatalog}
                        modelCatalogStatus={modelCatalogStatus}
                      >
                        <span className="model-item-name">{model}</span>
                      </ModelStatsHoverCard>
                      <div className="model-item-actions">
                        {renderCompactModelUpgradePolicyControl(upgradeTarget)}
                        <button
                          className="model-item-remove"
                          onClick={() => removeModel(i)}
                          disabled={models.length <= 1}
                          title={models.length <= 1 ? 'At least one debate model is required.' : 'Remove this model from the debate roster.'}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    {renderResolvedModelUpgradeSuggestionNotice(upgradeTarget)}
                  </div>
                );
              })}
            </div>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={newModelProvider}
                onChange={e => setNewModelProvider(e.target.value)}
                disabled={providerOptions.length === 0}
                title="Choose how the model ID should be interpreted before adding it."
              >
                {providerOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <input
                type="text"
                className="settings-input"
                placeholder={newModelProvider === 'openrouter' ? 'openrouter-model' : 'model-name'}
                value={newModel}
                onChange={e => setNewModel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addModel()}
                list={providerModelOptions.length > 0 ? `provider-models-${newModelProvider}` : undefined}
                title="Enter a model ID to add to the debate roster. OpenRouter expects full IDs; direct providers use the selected prefix."
              />
              <button
                className="model-add-btn"
                onClick={addModel}
                disabled={providerOptions.length === 0}
                title="Add the typed model to the debate roster."
              >
                <Plus size={14} />
                Add
              </button>
              {providerOptions.length > 0 && (
                <button
                  className="model-browse-btn"
                  onClick={() => setPickerOpen('debate')}
                  title="Browse the provider catalog and add a debate model from the list."
                >
                  Browse
                </button>
              )}
            </div>
            {providerModelOptions.length > 0 && (
              <datalist id={`provider-models-${newModelProvider}`}>
                {providerModelOptions.slice(0, 200).map((modelId) => (
                  <option key={modelId} value={modelId} />
                ))}
              </datalist>
            )}
            {providerOptions.length === 0 && (
              <p className="settings-hint">
                No providers are enabled on the server. Add API keys to the backend environment.
              </p>
            )}
            <p className="settings-hint">
              Prefix direct providers with <code>anthropic:</code>, <code>openai:</code>, or <code>gemini:</code>.
              Unprefixed models route through OpenRouter.
            </p>
            <p className="settings-hint">
              Examples: <code>anthropic:claude-3.7-sonnet</code>, <code>openai:gpt-4.1</code>, <code>gemini:gemini-2.5-flash</code>.
            </p>
            <div className="settings-smart-ranking">
              <label className="settings-label settings-sub-label">
                <Wand2 size={13} />
                <span className="settings-label-copy">
                  <span>Smart Ranking</span>
                  <InfoTip
                    label="Smart ranking help"
                    content={[
                      'Ranks candidate models using catalog metadata, benchmark priors, and local telemetry.',
                      'Use it to auto-fill the roster when you want balanced, fast, cheap, quality-first, or frontier-biased picks.',
                    ]}
                  />
                </span>
              </label>
              <div className="model-add-row">
                <select
                  className="settings-input settings-select"
                  value={rankingMode}
                  onChange={e => setRankingMode(e.target.value)}
                  title="Choose what Smart Ranking should optimize for when suggesting models."
                >
                  <option value="balanced">Balanced</option>
                  <option value="fast">Fastest</option>
                  <option value="cheap">Lowest Cost</option>
                  <option value="quality">Highest Quality</option>
                  <option value="frontier">Frontier (Flagship/New)</option>
                </select>
                <button
                  className="settings-btn-secondary"
                  onClick={() => applyRankedTopModels(3)}
                  disabled={rankedModels.length === 0}
                  title="Replace the current debate roster with the top three ranked suggestions."
                >
                  Use Top 3
                </button>
              </div>
              <div className="settings-smart-ranking-options">
                <label className="settings-checkbox" title="Give extra weight to providers' main flagship lines when ranking.">
                  <input
                    type="checkbox"
                    checked={rankingPreferFlagship}
                    onChange={e => setRankingPreferFlagship(e.target.checked)}
                  />
                  <span>Prioritize flagship model families</span>
                </label>
                <label className="settings-checkbox" title="Boost recently released models when ranking choices.">
                  <input
                    type="checkbox"
                    checked={rankingPreferNew}
                    onChange={e => setRankingPreferNew(e.target.checked)}
                  />
                  <span>Boost newly released models</span>
                </label>
                <label className="settings-checkbox" title="Include preview and beta models in ranked suggestions. Disable this if you want steadier production picks.">
                  <input
                    type="checkbox"
                    checked={rankingAllowPreview}
                    onChange={e => setRankingAllowPreview(e.target.checked)}
                  />
                  <span>Include preview/beta models</span>
                </label>
              </div>
              <p className="settings-hint">
                Frontier mode emphasizes quality + recency, then reliability. Disable preview if you want more stable picks.
              </p>
              {rankedModels.length > 0 && (
                <div className="settings-ranked-list">
                  {rankedModels.slice(0, 6).map((item) => (
                    <ModelStatsHoverCard
                      key={item.modelId}
                      modelId={item.modelId}
                      modelCatalog={modelCatalog}
                      modelCatalogStatus={modelCatalogStatus}
                      focusable={false}
                    >
                      <button
                        className="settings-ranked-item"
                        onClick={() => addModelId(item.modelId)}
                        disabled={models.includes(item.modelId)}
                        aria-label={
                          models.includes(item.modelId)
                            ? `${item.modelId} already selected`
                            : `Add ${item.modelId} with score ${item.score}`
                        }
                        type="button"
                      >
                        <span className="settings-ranked-header">
                          <span className="settings-ranked-model">{item.modelId}</span>
                          <span className="settings-ranked-score">Score {item.score}</span>
                        </span>
                        {item.highlights?.length > 0 && (
                          <span className="settings-ranked-reasons">
                            {item.highlights.join(' · ')}
                          </span>
                        )}
                        <span className="settings-ranked-meta">
                          {formatRankingTelemetrySummary(item)}
                        </span>
                      </button>
                    </ModelStatsHoverCard>
                  ))}
                </div>
              )}
            </div>
            {providerStatusState === 'error' && (
              <p className="settings-hint">
                Provider status unavailable: {providerStatusError || 'check the backend'}.
              </p>
            )}
          </div>

          <div
            ref={(node) => setSettingsTargetRef(synthUpgradeTarget?.key, node)}
            data-settings-target-key={synthUpgradeTarget?.key || undefined}
            tabIndex={synthUpgradeTarget?.key ? -1 : undefined}
            className={getSettingsTargetClassName('settings-section', synthUpgradeTarget?.key)}
          >
            <label className="settings-label">
              <RotateCcw size={14} />
              <span className="settings-label-copy">
                <span>Max Debate Rounds</span>
                <InfoTip
                  label="Max debate rounds help"
                  content={[
                    'Caps how many rounds the debaters can run before the app stops and synthesizes what it has.',
                    'Higher values allow deeper rebuttals but cost more and take longer.',
                  ]}
                />
              </span>
            </label>
            <div className="slider-row">
              <input
                type="range"
                className="settings-slider"
                min={1}
                max={10}
                value={maxRounds}
                onChange={e => setMaxRounds(Number(e.target.value))}
                title="Maximum number of debate rounds allowed before the run stops and synthesizes."
              />
              <span className="slider-value">{maxRounds}</span>
            </div>
            <p className="settings-hint">
              {maxRounds === 1
                ? 'Single round - models respond once, then synthesis.'
                : `Up to ${maxRounds} rounds - models debate and refine positions.`}
            </p>
            <label className="settings-checkbox" title="Run one last agreement check after the final round, even if the debate is about to stop.">
              <input
                type="checkbox"
                checked={convOnFinalRound}
                onChange={e => setConvOnFinalRound(e.target.checked)}
              />
              <span>Run convergence check on final round</span>
            </label>
            <p className="settings-hint">
              Useful for 2-round debates so agreement/disagreement summaries still appear.
            </p>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Sparkles size={14} />
              <span className="settings-label-copy">
                <span>Synthesizer Model</span>
                <InfoTip
                  label="Synthesizer model help"
                  content={[
                    'This model reads the debate or ensemble outputs and writes the final answer shown to you.',
                    'Choose a model you trust for summarization, arbitration, and citation handling.',
                  ]}
                />
              </span>
            </label>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={synthProvider}
                onChange={e => setSynthProvider(e.target.value)}
                disabled={providerOptions.length === 0}
                title={PROVIDER_FIELD_HELP.join(' ')}
              >
                {providerOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <input
                type="text"
                className="settings-input"
                placeholder={synthProvider === 'openrouter' ? 'openrouter-model' : 'model-name'}
                value={synth}
                onChange={e => setSynth(e.target.value)}
                onFocus={() => {
                  synthEditingRef.current = true;
                }}
                onBlur={(e) => {
                  synthEditingRef.current = false;
                  const nextValue = normalizeModelForProvider(synthProvider, e.target.value) || e.target.value.trim();
                  if (nextValue !== synthesizerModel) {
                    dispatch({ type: 'SET_SYNTHESIZER', payload: nextValue });
                  }
                }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-form-type="other"
                data-lpignore="true"
                title={`Model used to produce the final synthesized answer after the run completes. ${getModelStatsTitle(normalizedSynthValue)}`}
              />
              <button
                className="model-browse-btn"
                onClick={() => setPickerOpen('synth')}
                title="Browse and choose a synthesizer model from the provider catalog."
              >
                Browse
              </button>
              {renderCompactModelUpgradePolicyControl(synthUpgradeTarget, {
                className: 'settings-inline-upgrade-control-inline',
              })}
            </div>
            {renderResolvedModelUpgradeSuggestionNotice(synthUpgradeTarget)}
          </div>

          <div
            ref={(node) => setSettingsTargetRef(convergenceUpgradeTarget?.key, node)}
            data-settings-target-key={convergenceUpgradeTarget?.key || undefined}
            tabIndex={convergenceUpgradeTarget?.key ? -1 : undefined}
            className={getSettingsTargetClassName('settings-section', convergenceUpgradeTarget?.key)}
          >
            <label className="settings-label">
              <GitCompareArrows size={14} />
              <span className="settings-label-copy">
                <span>Convergence Check Model</span>
                <InfoTip
                  label="Convergence model help"
                  content={[
                    'This model decides whether the debaters are meaningfully agreeing or still diverging between rounds.',
                    'A fast and inexpensive model usually works best here because it runs during the debate, not after it.',
                  ]}
                />
              </span>
            </label>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={convProvider}
                onChange={e => setConvProvider(e.target.value)}
                disabled={providerOptions.length === 0}
                title={PROVIDER_FIELD_HELP.join(' ')}
              >
                {providerOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <input
                type="text"
                className="settings-input"
                placeholder={convProvider === 'openrouter' ? 'openrouter-model' : 'model-name'}
                value={convModel}
                onChange={e => setConvModel(e.target.value)}
                onFocus={() => {
                  convEditingRef.current = true;
                }}
                onBlur={(e) => {
                  convEditingRef.current = false;
                  const nextValue = normalizeModelForProvider(convProvider, e.target.value) || e.target.value.trim();
                  if (nextValue !== convergenceModel) {
                    dispatch({ type: 'SET_CONVERGENCE_MODEL', payload: nextValue });
                  }
                }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-form-type="other"
                data-lpignore="true"
                title={`Model used to judge agreement between debaters after each round. ${getModelStatsTitle(normalizedConvergenceValue)}`}
              />
              <button
                className="model-browse-btn"
                onClick={() => setPickerOpen('convergence')}
                title="Browse and choose the convergence checker model."
              >
                Browse
              </button>
              {renderCompactModelUpgradePolicyControl(convergenceUpgradeTarget, {
                className: 'settings-inline-upgrade-control-inline',
              })}
            </div>
            {renderResolvedModelUpgradeSuggestionNotice(convergenceUpgradeTarget)}
            <p className="settings-hint">
              A fast model used to check if debaters have reached consensus between rounds.
            </p>
          </div>

          <div
            ref={(node) => setSettingsTargetRef(searchUpgradeTarget?.key, node)}
            data-settings-target-key={searchUpgradeTarget?.key || undefined}
            tabIndex={searchUpgradeTarget?.key ? -1 : undefined}
            className={getSettingsTargetClassName('settings-section', searchUpgradeTarget?.key)}
          >
            <label className="settings-label">
              <Globe size={14} />
              <span className="settings-label-copy">
                <span>Web Search Model</span>
                <InfoTip
                  label="Web search model help"
                  content={[
                    'This model is only used when the composer Search toggle is on.',
                    'Pick a model that can browse, cite sources, and report dates clearly.',
                  ]}
                />
              </span>
            </label>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={searchProvider}
                onChange={e => setSearchProvider(e.target.value)}
                disabled={providerOptions.length === 0}
                title={PROVIDER_FIELD_HELP.join(' ')}
              >
                {providerOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <input
                type="text"
                className="settings-input"
                placeholder={searchProvider === 'openrouter' ? 'openrouter-model' : 'model-name'}
                value={searchModel}
                onChange={e => setSearchModel(e.target.value)}
                onFocus={() => {
                  searchEditingRef.current = true;
                }}
                onBlur={(e) => {
                  searchEditingRef.current = false;
                  const nextValue = normalizeModelForProvider(searchProvider, e.target.value) || e.target.value.trim();
                  if (nextValue !== webSearchModel) {
                    dispatch({ type: 'SET_WEB_SEARCH_MODEL', payload: nextValue });
                  }
                }}
                title={getModelStatsTitle(normalizedSearchValue)}
                list={getProviderModelOptions(searchProvider).length > 0 ? `provider-models-search-${searchProvider}` : undefined}
              />
              <button
                className="model-browse-btn"
                onClick={() => setPickerOpen('search')}
                title="Browse and choose the model used for Search-enabled turns."
              >
                Browse
              </button>
              {renderCompactModelUpgradePolicyControl(searchUpgradeTarget, {
                className: 'settings-inline-upgrade-control-inline',
              })}
            </div>
            {renderResolvedModelUpgradeSuggestionNotice(searchUpgradeTarget)}
            {getProviderModelOptions(searchProvider).length > 0 && (
              <datalist id={`provider-models-search-${searchProvider}`}>
                {getProviderModelOptions(searchProvider).slice(0, 200).map((modelId) => (
                  <option key={modelId} value={modelId} />
                ))}
              </datalist>
            )}
            <p className="settings-hint">
              A model with web search capabilities (e.g. Perplexity Sonar via OpenRouter). Used when the Search toggle is active.
            </p>
            <label
              className="settings-checkbox"
              title="When enabled, search-assisted answers must include verifiable sources and dates or the app blocks them."
            >
              <input
                type="checkbox"
                checked={strictSearch}
                onChange={e => setStrictSearch(e.target.checked)}
              />
              <span className="settings-checkbox-copy">
                <span>Strict search verification (block unverified answers)</span>
                <InfoTip
                  label="Strict search help"
                  content={[
                    'Use this when you would rather get a blocked result than accept a weakly sourced search answer.',
                    'If the search model does not provide URLs and date evidence, the app retries with legacy search context before failing.',
                  ]}
                />
              </span>
            </label>
            <p className="settings-hint">
              Requires source URLs and date evidence on Search-enabled first-round responses. If missing, the app auto-retries with legacy search context.
            </p>
          </div>

            </>
          )}

          {activeSettingsPane === 'reliability' && (
            <>
          <div className="settings-section">
            <label className="settings-label">
              <Shield size={14} />
              <span className="settings-label-copy">
                <span>Retry & Resilience</span>
                <InfoTip
                  label="Retry and resilience help"
                  content={[
                    'These controls decide how aggressively the app retries transient failures.',
                    'Higher values improve recovery but can make a turn take longer and cost more.',
                  ]}
                />
              </span>
            </label>
            <div className="settings-grid-compact">
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Max attempts</span>
                  <InfoTip content="Maximum tries per request before the app gives up and marks that stream as failed." label="Max attempts help" />
                </span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  className="settings-input"
                  value={retryMaxAttempts}
                  onChange={e => setRetryMaxAttempts(Number(e.target.value))}
                  title="Maximum tries per request before a stream is marked as failed."
                />
              </label>
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Base delay (ms)</span>
                  <InfoTip content="Starting backoff delay before the first retry. Later retries grow from here." label="Base delay help" />
                </span>
                <input
                  type="number"
                  min={100}
                  max={10000}
                  step={100}
                  className="settings-input"
                  value={retryBaseDelayMs}
                  onChange={e => setRetryBaseDelayMs(Number(e.target.value))}
                  title="Initial wait before retrying a failed request."
                />
              </label>
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Max delay (ms)</span>
                  <InfoTip content="Upper bound for exponential backoff. Keeps long outages from stretching retries forever." label="Max delay help" />
                </span>
                <input
                  type="number"
                  min={retryBaseDelayMs || 100}
                  max={30000}
                  step={100}
                  className="settings-input"
                  value={retryMaxDelayMs}
                  onChange={e => setRetryMaxDelayMs(Number(e.target.value))}
                  title="Cap on retry backoff delay."
                />
              </label>
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Circuit failures</span>
                  <InfoTip content="How many consecutive failures trigger the provider circuit breaker for a route." label="Circuit failures help" />
                </span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="settings-input"
                  value={circuitFailureThreshold}
                  onChange={e => setCircuitFailureThreshold(Number(e.target.value))}
                  title="Consecutive failures required before a route is temporarily opened by the circuit breaker."
                />
              </label>
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Cooldown (ms)</span>
                  <InfoTip content="How long the circuit breaker waits before it allows traffic to try that route again." label="Cooldown help" />
                </span>
                <input
                  type="number"
                  min={5000}
                  max={600000}
                  step={1000}
                  className="settings-input"
                  value={circuitCooldownMs}
                  onChange={e => setCircuitCooldownMs(Number(e.target.value))}
                  title="Time a tripped route stays paused before traffic is allowed again."
                />
              </label>
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Activity size={14} />
              <span className="settings-label-copy">
                <span>Diagnostics</span>
                <InfoTip
                  label="Diagnostics help"
                  content={[
                    'Diagnostics summarize local telemetry about failures, latency, retries, and cache behavior.',
                    'This data only reflects runs from this browser profile and helps the ranking system adapt over time.',
                  ]}
                />
              </span>
            </label>
            <p className="settings-hint">
              Global route telemetry for failures and retry behavior. Ranking cards above also blend public benchmark priors with per-model ensemble judge feedback when available.
            </p>
            {diagnosticsSummary.hasData ? (
              <>
                <div className="settings-diagnostics-grid">
                  <div className="settings-diagnostics-card">
                    <span className="settings-diagnostics-label">Calls observed</span>
                    <strong className="settings-diagnostics-value">{diagnosticsSummary.totalCalls}</strong>
                  </div>
                  <div className="settings-diagnostics-card">
                    <span className="settings-diagnostics-label">Success rate</span>
                    <strong className="settings-diagnostics-value">
                      {diagnosticsSummary.successRate != null ? `${diagnosticsSummary.successRate}%` : '--'}
                    </strong>
                  </div>
                  <div className="settings-diagnostics-card">
                    <span className="settings-diagnostics-label">Avg. first answer</span>
                    <strong className="settings-diagnostics-value">{diagnosticsSummary.avgFirstAnswer}</strong>
                  </div>
                  <div className="settings-diagnostics-card">
                    <span className="settings-diagnostics-label">Retry recovery</span>
                    <strong className="settings-diagnostics-value">{diagnosticsSummary.retryRecovery}</strong>
                  </div>
                  <div className="settings-diagnostics-card">
                    <span className="settings-diagnostics-label">Cache reads</span>
                    <strong className="settings-diagnostics-value">{diagnosticsSummary.promptCacheReads}</strong>
                  </div>
                  <div className="settings-diagnostics-card">
                    <span className="settings-diagnostics-label">Cache writes</span>
                    <strong className="settings-diagnostics-value">{diagnosticsSummary.promptCacheWrites}</strong>
                  </div>
                </div>
                <div className="settings-diagnostics-provider">
                  <span className="settings-diagnostics-provider-label">
                    Provider cache requests
                  </span>
                  <code>{diagnosticsSummary.promptCacheActivity}</code>
                </div>
                {diagnosticsSummary.topProviderFailure && (
                  <div className="settings-diagnostics-provider">
                    <span className="settings-diagnostics-provider-label">
                      Most failures: <strong>{diagnosticsSummary.topProviderFailure[1]}</strong>
                    </span>
                    <code>{diagnosticsSummary.topProviderFailure[0]}</code>
                  </div>
                )}
                <div className="settings-diagnostics-actions">
                  <button
                    className="settings-btn-secondary"
                    type="button"
                    onClick={resetDiagnostics}
                    title="Clear the local diagnostics history collected in this browser profile."
                  >
                    Reset Diagnostics
                  </button>
                </div>
              </>
            ) : (
              <p className="settings-hint">No diagnostics have been collected in this browser profile yet.</p>
            )}
          </div>

            </>
          )}

          {activeSettingsPane === 'budget' && (
            <>
          <div className="settings-section">
            <label className="settings-label">
              <DollarSign size={14} />
              <span className="settings-label-copy">
                <span>Budget Guardrails</span>
                <InfoTip
                  label="Budget guardrails help"
                  content={[
                    'These controls compare the estimated turn cost against your thresholds before sending.',
                    'Use them if you want a pause before very expensive prompts or large attachment-heavy runs.',
                  ]}
                />
              </span>
            </label>
            <label className="settings-checkbox" title="Turn on a confirmation step whenever the estimated cost is above your limits.">
              <input
                type="checkbox"
                checked={budgetEnabled}
                onChange={e => setBudgetEnabled(e.target.checked)}
              />
              <span>Require confirmation for expensive prompts</span>
            </label>
            <div className="settings-grid-compact">
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Soft limit (USD)</span>
                  <InfoTip content="If the estimate is above this value, the app pauses and asks you to confirm the send." label="Soft limit help" />
                </span>
                <input
                  type="number"
                  min={0}
                  step={0.05}
                  className="settings-input"
                  value={budgetSoftLimit}
                  onChange={e => setBudgetSoftLimit(Number(e.target.value))}
                  disabled={!budgetEnabled}
                  title="Estimated turns above this amount require a confirmation."
                />
              </label>
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Auto-approve below</span>
                  <InfoTip content="Turns below this amount skip the confirmation even when the soft limit feature is enabled." label="Auto-approve help" />
                </span>
                <input
                  type="number"
                  min={0}
                  step={0.05}
                  className="settings-input"
                  value={budgetAutoApprove}
                  onChange={e => setBudgetAutoApprove(Number(e.target.value))}
                  disabled={!budgetEnabled}
                  title="Estimated turns below this amount are sent without a budget confirmation."
                />
              </label>
            </div>
          </div>

            </>
          )}

          {activeSettingsPane === 'performance' && (
            <>
          <div className="settings-section">
            <label className="settings-label">
              <Gauge size={14} />
              <span className="settings-label-copy">
                <span>Performance</span>
                <InfoTip
                  label="Performance help"
                  content={[
                    'Performance settings reduce render cost for long chats and large debates.',
                    'Use them if the UI becomes sluggish with many rounds or large threads.',
                  ]}
                />
              </span>
            </label>
            <label className="settings-checkbox" title="Render only the visible portion of older round lists to keep long debates responsive.">
              <input
                type="checkbox"
                checked={virtualizationEnabled}
                onChange={e => setVirtualizationEnabled(e.target.checked)}
              />
              <span>Virtualize older rounds for faster rendering</span>
            </label>
            <label className="settings-inline-field">
              <span className="settings-inline-label">
                <span>Keep latest rounds</span>
                <InfoTip content="Newest rounds that stay fully mounted before the app starts virtualizing older ones." label="Keep latest rounds help" />
              </span>
              <input
                type="number"
                min={2}
                max={12}
                className="settings-input"
                value={virtualizationKeepLatest}
                onChange={e => setVirtualizationKeepLatest(Number(e.target.value))}
                disabled={!virtualizationEnabled}
                title="How many newest rounds stay fully rendered before virtualization starts."
              />
            </label>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Database size={14} />
              <span className="settings-label-copy">
                <span>Provider Prompt Cache</span>
                <InfoTip
                  label="Provider prompt cache help"
                  content={[
                    'Provider prompt caching can reduce repeated input cost on long stable prompts.',
                    'The server applies provider-specific rules and skips requests that are below provider token thresholds.',
                  ]}
                />
              </span>
            </label>
            <label className="settings-checkbox" title="Allow supported providers to use prompt caching for long reusable prompt prefixes.">
              <input
                type="checkbox"
                checked={promptCacheEnabled}
                onChange={e => setPromptCacheEnabled(e.target.checked)}
              />
              <span>Enable provider prompt caching</span>
            </label>
            <div className="settings-grid-compact">
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Claude TTL</span>
                  <InfoTip content="Default uses the provider's normal ephemeral cache lifetime. One hour is only sent for supported Claude cache breakpoints." label="Claude TTL help" />
                </span>
                <select
                  className="settings-input settings-select"
                  value={promptCacheClaudeTtl}
                  onChange={e => setPromptCacheClaudeTtl(e.target.value)}
                  disabled={!promptCacheEnabled}
                  title="Claude prompt cache time-to-live preference."
                >
                  <option value="default">Default</option>
                  <option value="1h">1 hour</option>
                </select>
              </label>
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>OpenAI retention</span>
                  <InfoTip content="Default leaves retention unset. In-memory is the normal short cache. 24h is sent only for models that support extended prompt caching." label="OpenAI retention help" />
                </span>
                <select
                  className="settings-input settings-select"
                  value={promptCacheOpenAIRetention}
                  onChange={e => setPromptCacheOpenAIRetention(e.target.value)}
                  disabled={!promptCacheEnabled}
                  title="OpenAI prompt cache retention preference."
                >
                  <option value="default">Default</option>
                  <option value="in-memory">In-memory</option>
                  <option value="24h">24 hours</option>
                </select>
              </label>
              <label className="settings-inline-field">
                <span className="settings-inline-label">
                  <span>Gemini TTL</span>
                  <InfoTip content="Explicit Gemini cachedContent entries are created only for large reusable attachment blocks." label="Gemini TTL help" />
                </span>
                <select
                  className="settings-input settings-select"
                  value={String(promptCacheGeminiTtlSeconds)}
                  onChange={e => setPromptCacheGeminiTtlSeconds(Number(e.target.value))}
                  disabled={!promptCacheEnabled || !promptCacheGeminiExplicit}
                  title="Direct Gemini explicit cache time-to-live."
                >
                  <option value="300">5 minutes</option>
                  <option value="3600">1 hour</option>
                </select>
              </label>
            </div>
            <label className="settings-checkbox" title="Create direct Gemini cachedContent entries for large stable attachment prompts.">
              <input
                type="checkbox"
                checked={promptCacheGeminiExplicit}
                onChange={e => setPromptCacheGeminiExplicit(e.target.checked)}
                disabled={!promptCacheEnabled}
              />
              <span>Use explicit Gemini cachedContent for large attachments</span>
            </label>
            <label className="settings-checkbox" title="Let the first matching long request finish before parallel duplicate requests hit the same provider cache key.">
              <input
                type="checkbox"
                checked={promptCacheWarmupSerialization}
                onChange={e => setPromptCacheWarmupSerialization(e.target.checked)}
                disabled={!promptCacheEnabled}
              />
              <span>Serialize first long cache write</span>
            </label>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Database size={14} />
              <span className="settings-label-copy">
                <span>Response Cache</span>
                <InfoTip
                  label="Response cache help"
                  content={[
                    'The response cache reuses compatible results instead of calling providers again.',
                    'Persist it if you want cache hits to survive app restarts on this machine.',
                  ]}
                />
              </span>
            </label>
            <label className="settings-checkbox" title="Store cached responses locally so they are still available after the app restarts.">
              <input
                type="checkbox"
                checked={cachePersistence}
                onChange={e => setCachePersistence(e.target.checked)}
              />
              <span>Persist cache across app restarts</span>
            </label>
            <div className="settings-cache-row">
              <span className="settings-hint">
                Hits: <strong>{cacheHitCount}</strong> | Entries: <strong>{cacheEntryCount}</strong>
              </span>
              <button
                className="settings-btn-secondary"
                onClick={clearResponseCache}
                type="button"
                title="Delete cached responses saved for this browser profile."
              >
                Clear Cache
              </button>
            </div>
          </div>

            </>
          )}

        </div>

        <div className="settings-footer">
          <button className="settings-btn-secondary" onClick={resetDefaults} title="Restore the default app configuration for this browser profile.">
            Reset Defaults
          </button>
          <button
            className="settings-btn-primary"
            onClick={handleSave}
            title="Close settings and keep the changes currently applied."
          >
            Done
          </button>
        </div>
        {presetSheet && (
          <div className="settings-sheet-backdrop" onClick={closePresetSheet}>
            <div
              className="settings-sheet glass-panel"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={presetSheet.title}
            >
              <div className="settings-sheet-header">
                <h3>{presetSheet.title}</h3>
                <button className="settings-close" type="button" onClick={closePresetSheet} aria-label={`Close ${presetSheet.title}`}>
                  <X size={16} />
                </button>
              </div>
              <form
                className="settings-sheet-body"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitPresetSheet();
                }}
              >
                <p className="settings-hint settings-sheet-text">{presetSheet.description}</p>
                {presetSheet.requiresValue && (
                  <input
                    ref={presetSheetInputRef}
                    type="text"
                    className="settings-input"
                    value={presetSheetValue}
                    onChange={(event) => setPresetSheetValue(event.target.value)}
                    placeholder="Preset name"
                  />
                )}
                <div className="settings-sheet-actions">
                  <button
                    type="button"
                    className="settings-btn-secondary"
                    onClick={closePresetSheet}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={presetSheet.destructive ? 'settings-btn-danger' : 'settings-btn-primary'}
                    disabled={presetSheet.requiresValue && !String(presetSheetValue || '').trim()}
                  >
                    {presetSheet.confirmLabel}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        {appUpdateRestartSheetOpen && (
          <div className="settings-sheet-backdrop" onClick={closeAppUpdateRestartSheet}>
            <div
              className="settings-sheet glass-panel"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Restart app confirmation"
            >
              <div className="settings-sheet-header">
                <h3>Restart App</h3>
                <button
                  className="settings-close"
                  type="button"
                  onClick={closeAppUpdateRestartSheet}
                  aria-label="Close restart confirmation"
                >
                  <X size={16} />
                </button>
              </div>
              <form
                className="settings-sheet-body"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleConfirmAppRestart();
                }}
              >
                <p className="settings-hint settings-sheet-text">
                  This update changed backend code or dependencies on this machine. Restart the app now to finish loading the new version?
                </p>
                <div className="settings-sheet-actions">
                  <button
                    type="button"
                    className="settings-btn-secondary"
                    onClick={closeAppUpdateRestartSheet}
                    disabled={appUpdateState === 'restarting'}
                  >
                    Not Now
                  </button>
                  <button
                    type="submit"
                    className="settings-btn-primary"
                    autoFocus
                    disabled={appUpdateState === 'restarting'}
                  >
                    {appUpdateState === 'restarting' ? 'Restarting...' : 'Restart Now'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
      <ModelPickerModal
        open={Boolean(pickerOpen)}
        onClose={() => setPickerOpen(false)}
        apiKey={apiKey}
        provider={pickerOpen === 'synth'
          ? synthProvider
          : pickerOpen === 'convergence'
            ? convProvider
            : pickerOpen === 'search'
              ? searchProvider
              : newModelProvider}
        onAdd={(modelId) => {
          if (!modelId) return;
          const nameOnly = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
          if (pickerOpen === 'synth') {
            setSynth(buildProviderValue(synthProvider, synthProvider === 'openrouter' ? modelId : nameOnly));
          } else if (pickerOpen === 'convergence') {
            setConvModel(buildProviderValue(convProvider, convProvider === 'openrouter' ? modelId : nameOnly));
          } else if (pickerOpen === 'search') {
            setSearchModel(buildProviderValue(searchProvider, searchProvider === 'openrouter' ? modelId : nameOnly));
          } else {
            let resolvedId = modelId;
            if (newModelProvider !== 'openrouter') {
              resolvedId = `${newModelProvider}:${nameOnly}`;
            }
            addModelId(resolvedId);
          }
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
