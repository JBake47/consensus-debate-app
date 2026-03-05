import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Key, Cpu, Sparkles, Plus, Trash2, RotateCcw, GitCompareArrows, Globe, Shield, DollarSign, Wand2, Gauge, Database, Activity, MoreHorizontal } from 'lucide-react';
import { useDebateActions, useDebateSettings, useDebateUi } from '../context/DebateContext';
import {
  DEFAULT_DEBATE_MODELS,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_CONVERGENCE_MODEL,
  DEFAULT_MAX_DEBATE_ROUNDS,
  DEFAULT_WEB_SEARCH_MODEL,
} from '../lib/openrouter';
import { DEFAULT_RETRY_POLICY } from '../lib/retryPolicy';
import { rankModels } from '../lib/modelRanking';
import ModelPickerModal from './ModelPickerModal';
import './SettingsModal.css';

const DEFAULT_CONVERGENCE_ON_FINAL_ROUND = true;

function formatDurationCompact(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function presetMatchesDraft(preset, draft) {
  if (!preset || !draft) return false;
  const presetModels = Array.isArray(preset.models) ? preset.models : [];
  const draftModels = Array.isArray(draft.models) ? draft.models : [];
  if (presetModels.length !== draftModels.length) return false;
  for (let index = 0; index < presetModels.length; index += 1) {
    if (presetModels[index] !== draftModels[index]) return false;
  }
  return (
    String(preset.synthesizerModel || '') === String(draft.synthesizerModel || '')
    && String(preset.convergenceModel || '') === String(draft.convergenceModel || '')
    && String(preset.webSearchModel || '') === String(draft.webSearchModel || '')
    && Number(preset.maxDebateRounds || 0) === Number(draft.maxDebateRounds || 0)
  );
}

function buildUniquePresetName(baseName, presets, excludeId = null) {
  const root = String(baseName || 'New Preset').trim() || 'New Preset';
  const existing = new Set(
    (presets || [])
      .filter((preset) => preset?.id !== excludeId)
      .map((preset) => String(preset?.name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (!existing.has(root.toLowerCase())) return root;
  let index = 2;
  let candidate = `${root} ${index}`;
  while (existing.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${root} ${index}`;
  }
  return candidate;
}

function createPresetId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export default function SettingsModal() {
  const {
    apiKey, selectedModels, synthesizerModel,
    convergenceModel, convergenceOnFinalRound, maxDebateRounds, webSearchModel, strictWebSearch,
    retryPolicy, budgetGuardrailsEnabled, budgetSoftLimitUsd, budgetAutoApproveBelowUsd,
    smartRankingMode, smartRankingPreferFlagship, smartRankingPreferNew, smartRankingAllowPreview,
    streamVirtualizationEnabled, streamVirtualizationKeepLatest,
    cachePersistenceEnabled, cacheHitCount, cacheEntryCount,
    rememberApiKey, providerStatus, providerStatusState, providerStatusError, modelCatalog, modelCatalogStatus, modelPresets, metrics,
  } = useDebateSettings();
  const { showSettings } = useDebateUi();
  const { clearResponseCache, resetDiagnostics, dispatch } = useDebateActions();
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
  const [virtualizationEnabled, setVirtualizationEnabled] = useState(Boolean(streamVirtualizationEnabled));
  const [virtualizationKeepLatest, setVirtualizationKeepLatest] = useState(Number(streamVirtualizationKeepLatest || 4));
  const [cachePersistence, setCachePersistence] = useState(Boolean(cachePersistenceEnabled));
  const [rememberKey, setRememberKey] = useState(rememberApiKey);
  const [debouncedKeyInput, setDebouncedKeyInput] = useState(apiKey);
  const [newModel, setNewModel] = useState('');
  const [newModelProvider, setNewModelProvider] = useState('openrouter');
  const [pickerOpen, setPickerOpen] = useState(null);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetSheet, setPresetSheet] = useState(null);
  const [presetSheetValue, setPresetSheetValue] = useState('');
  const [synthProvider, setSynthProvider] = useState('openrouter');
  const [convProvider, setConvProvider] = useState('openrouter');
  const [searchProvider, setSearchProvider] = useState('openrouter');
  const presetSheetInputRef = useRef(null);
  const liveApplyReadyRef = useRef(false);

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

  const handleSave = () => {
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: false });
  };

  const handleClose = () => {
    liveApplyReadyRef.current = false;
    setPresetSheet(null);
    setPresetSheetValue('');
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
      limit: 8,
    }),
    [modelCatalog, metrics, rankingMode, rankingPreferFlagship, rankingPreferNew, rankingAllowPreview]
  );
  const currentPresetSnapshot = useMemo(() => ({
    models,
    synthesizerModel: normalizeModelForProvider(synthProvider, synth) || synth,
    convergenceModel: normalizeModelForProvider(convProvider, convModel) || convModel,
    maxDebateRounds: Number.isFinite(Number(maxRounds)) ? Number(maxRounds) : 0,
    webSearchModel: normalizeModelForProvider(searchProvider, searchModel) || searchModel,
  }), [models, synthProvider, synth, convProvider, convModel, maxRounds, searchProvider, searchModel]);
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
  const diagnosticsSummary = useMemo(() => {
    const callCount = Number(metrics?.callCount || 0);
    const successCount = Number(metrics?.successCount || 0);
    const failureCount = Number(metrics?.failureCount || 0);
    const retryAttempts = Number(metrics?.retryAttempts || 0);
    const retryRecovered = Number(metrics?.retryRecovered || 0);
    const samples = Array.isArray(metrics?.firstAnswerTimes) ? metrics.firstAnswerTimes : [];
    const avgFirstAnswerMs = samples.length > 0
      ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
      : null;
    const providerFailures = metrics?.failureByProvider && typeof metrics.failureByProvider === 'object'
      ? Object.entries(metrics.failureByProvider).sort((a, b) => b[1] - a[1])
      : [];

    return {
      hasData: callCount > 0 || failureCount > 0 || retryAttempts > 0,
      totalCalls: callCount,
      successRate: callCount > 0 ? Math.round((successCount / callCount) * 100) : null,
      avgFirstAnswer: formatDurationCompact(avgFirstAnswerMs),
      retryRecovery: retryAttempts > 0 ? `${retryRecovered} of ${retryAttempts}` : 'No retries',
      topProviderFailure: providerFailures[0] || null,
    };
  }, [metrics]);

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
    if (!providerOptions.find(p => p.id === newModelProvider) && providerOptions.length > 0) {
      setNewModelProvider(providerOptions[0].id);
    }
  }, [providerOptions, newModelProvider]);

  useEffect(() => {
    if (!showSettings) return;
    setSelectedPresetId((current) => {
      if (current && modelPresets.some((preset) => preset.id === current)) return current;
      return activePresetMatch?.id || '';
    });
  }, [showSettings, modelPresets, activePresetMatch]);

  useEffect(() => {
    if (!showSettings) return;
    if (!activePresetMatch) return;
    if (selectedPreset && selectedPresetIsModified) return;
    if (selectedPresetId === activePresetMatch.id) return;
    setSelectedPresetId(activePresetMatch.id);
  }, [showSettings, activePresetMatch, selectedPreset, selectedPresetIsModified, selectedPresetId]);

  useEffect(() => {
    if (!presetSheet?.requiresValue) return;
    const timer = setTimeout(() => {
      presetSheetInputRef.current?.focus();
      presetSheetInputRef.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, [presetSheet]);

  useEffect(() => {
    if (!presetSheet) return;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closePresetSheet();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [presetSheet]);

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
    const top = rankedModels.slice(0, Math.max(1, count)).map((entry) => entry.modelId);
    if (top.length > 0) {
      setModels(top);
    }
  };

  const buildPayloadFromPreset = (preset, nameValue) => ({
    name: String(nameValue || preset?.name || '').trim(),
    models: Array.isArray(preset?.models) ? [...preset.models] : [],
    synthesizerModel: preset?.synthesizerModel || '',
    convergenceModel: preset?.convergenceModel || '',
    maxDebateRounds: Number.isFinite(Number(preset?.maxDebateRounds)) ? Number(preset.maxDebateRounds) : 0,
    webSearchModel: preset?.webSearchModel || '',
  });

  const closePresetSheet = () => {
    setPresetSheet(null);
    setPresetSheetValue('');
  };

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
    loadPresetValues(preset);
    setSelectedPresetId(preset.id);
  };

  const handlePresetSelection = (event) => {
    const nextId = event.target.value;
    if (!nextId) {
      setSelectedPresetId('');
      return;
    }
    const preset = modelPresets.find((entry) => entry.id === nextId);
    if (preset) {
      applyPreset(preset);
    } else {
      setSelectedPresetId(nextId);
    }
  };

  const openSaveAsPresetSheet = () => {
    const baseName = selectedPreset?.name
      ? `${selectedPreset.name} Copy`
      : activePresetMatch?.name
        ? `${activePresetMatch.name} Copy`
        : 'New Preset';
    setPresetSheet({
      mode: 'save-as',
      title: 'Save As Preset',
      confirmLabel: 'Save Preset',
      description: 'Create a new preset from the current draft.',
      requiresValue: true,
    });
    setPresetSheetValue(buildUniquePresetName(baseName, modelPresets));
  };

  const handleUpdatePreset = () => {
    if (!selectedPreset) return;
    dispatch({
      type: 'UPDATE_MODEL_PRESET',
      payload: {
        id: selectedPreset.id,
        ...buildPresetPayload(selectedPreset.name),
      },
    });
  };

  const openRenamePresetSheet = () => {
    if (!selectedPreset) return;
    setPresetSheet({
      mode: 'rename',
      title: 'Rename Preset',
      confirmLabel: 'Rename',
      description: `Rename "${selectedPreset.name}".`,
      requiresValue: true,
    });
    setPresetSheetValue(selectedPreset.name);
  };

  const openDuplicatePresetSheet = () => {
    if (!selectedPreset) return;
    setPresetSheet({
      mode: 'duplicate',
      title: 'Duplicate Preset',
      confirmLabel: 'Duplicate',
      description: `Create a copy of "${selectedPreset.name}".`,
      requiresValue: true,
    });
    setPresetSheetValue(buildUniquePresetName(`${selectedPreset.name} Copy`, modelPresets));
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
      const nextId = createPresetId();
      dispatch({
        type: 'ADD_MODEL_PRESET',
        payload: {
          id: nextId,
          ...buildPresetPayload(buildUniquePresetName(trimmedName, modelPresets)),
        },
      });
      setSelectedPresetId(nextId);
      closePresetSheet();
      return;
    }

    if (presetSheet.mode === 'rename') {
      if (!selectedPreset) return;
      const trimmedName = String(presetSheetValue || '').trim();
      if (!trimmedName) return;
      dispatch({
        type: 'UPDATE_MODEL_PRESET',
        payload: {
          id: selectedPreset.id,
          ...buildPayloadFromPreset(
            selectedPreset,
            buildUniquePresetName(trimmedName, modelPresets, selectedPreset.id)
          ),
        },
      });
      closePresetSheet();
      return;
    }

    if (presetSheet.mode === 'duplicate') {
      if (!selectedPreset) return;
      const trimmedName = String(presetSheetValue || '').trim();
      if (!trimmedName) return;
      const nextId = createPresetId();
      dispatch({
        type: 'ADD_MODEL_PRESET',
        payload: {
          id: nextId,
          ...buildPayloadFromPreset(selectedPreset, buildUniquePresetName(trimmedName, modelPresets)),
        },
      });
      setSelectedPresetId(nextId);
      closePresetSheet();
      return;
    }

    if (presetSheet.mode === 'delete') {
      if (!selectedPreset) return;
      dispatch({ type: 'DELETE_MODEL_PRESET', payload: selectedPreset.id });
      setSelectedPresetId('');
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
    setVirtualizationEnabled(true);
    setVirtualizationKeepLatest(4);
    setCachePersistence(true);
  };

  useEffect(() => {
    if (!showSettings) return;
    liveApplyReadyRef.current = false;
    setKeyInput(apiKey);
    setModels(selectedModels);
    setSynth(synthesizerModel);
    setConvModel(convergenceModel);
    setConvOnFinalRound(Boolean(convergenceOnFinalRound));
    setMaxRounds(maxDebateRounds);
    setSearchModel(webSearchModel);
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
    setVirtualizationEnabled(Boolean(streamVirtualizationEnabled));
    setVirtualizationKeepLatest(Number(streamVirtualizationKeepLatest || 4));
    setCachePersistence(Boolean(cachePersistenceEnabled));
    setRememberKey(rememberApiKey);
    setDebouncedKeyInput(apiKey.trim());
    closePresetSheet();
    setSelectedPresetId('');
    setSynthProvider(getDirectProviderFromValue(synthesizerModel));
    setConvProvider(getDirectProviderFromValue(convergenceModel));
    setSearchProvider(getDirectProviderFromValue(webSearchModel));
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
    streamVirtualizationEnabled,
    streamVirtualizationKeepLatest,
    cachePersistenceEnabled,
    rememberApiKey,
  ]);

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
    if (normalizedSynthValue !== synthesizerModel) {
      dispatch({ type: 'SET_SYNTHESIZER', payload: normalizedSynthValue });
    }
    if (normalizedConvergenceValue !== convergenceModel) {
      dispatch({ type: 'SET_CONVERGENCE_MODEL', payload: normalizedConvergenceValue });
    }
    if (Boolean(convOnFinalRound) !== Boolean(convergenceOnFinalRound)) {
      dispatch({ type: 'SET_CONVERGENCE_ON_FINAL_ROUND', payload: convOnFinalRound });
    }
    if (Number(maxRounds) !== Number(maxDebateRounds)) {
      dispatch({ type: 'SET_MAX_DEBATE_ROUNDS', payload: maxRounds });
    }
    if (normalizedSearchValue !== webSearchModel) {
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
    if (Boolean(virtualizationEnabled) !== Boolean(streamVirtualizationEnabled)) {
      dispatch({ type: 'SET_STREAM_VIRTUALIZATION_ENABLED', payload: virtualizationEnabled });
    }
    if (Number(virtualizationKeepLatest) !== Number(streamVirtualizationKeepLatest)) {
      dispatch({ type: 'SET_STREAM_VIRTUALIZATION_KEEP_LATEST', payload: virtualizationKeepLatest });
    }
    if (Boolean(cachePersistence) !== Boolean(cachePersistenceEnabled)) {
      dispatch({ type: 'SET_CACHE_PERSISTENCE_ENABLED', payload: cachePersistence });
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
    virtualizationEnabled,
    streamVirtualizationEnabled,
    virtualizationKeepLatest,
    streamVirtualizationKeepLatest,
    cachePersistence,
    cachePersistenceEnabled,
    dispatch,
  ]);

  if (!showSettings) return null;

  return (
    <div className="settings-overlay" onClick={handleClose}>
      <div className="settings-modal glass-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <label className="settings-label">
              <Key size={14} />
              <span>OpenRouter API Key (optional override)</span>
            </label>
            <input
              type="password"
              className="settings-input"
              placeholder="sk-or-... (optional)"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              autoFocus={!apiKey}
            />
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={e => setRememberKey(e.target.checked)}
              />
              <span>Remember key on this device</span>
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
              <span>Model Presets</span>
            </label>
            <div className="preset-selector-card">
              <div className="preset-compact-row">
                <select
                  className="settings-input settings-select preset-selector-input"
                  value={selectedPresetId}
                  onChange={handlePresetSelection}
                >
                  <option value="">Custom</option>
                  {modelPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                {selectedPreset && selectedPresetIsModified && (
                  <button
                    type="button"
                    className="settings-btn-secondary"
                    onClick={handleUpdatePreset}
                  >
                    Update Preset
                  </button>
                )}
                <button
                  type="button"
                  className="model-add-btn"
                  onClick={openSaveAsPresetSheet}
                >
                  <Plus size={14} />
                  Save As...
                </button>
                {selectedPreset && (
                  <details className="preset-menu">
                    <summary className="preset-menu-trigger" title="Preset Actions">
                      <MoreHorizontal size={16} />
                    </summary>
                    <div className="preset-menu-popover">
                      <button
                        type="button"
                        className="preset-menu-item"
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          openRenamePresetSheet();
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="preset-menu-item"
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          openDuplicatePresetSheet();
                        }}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="preset-menu-item danger"
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          openDeletePresetSheet();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </details>
                )}
              </div>
              <div className={`preset-status ${activePresetMatch ? 'is-match' : selectedPreset ? 'is-modified' : 'is-custom'}`}>
                {activePresetMatch ? (
                  <>
                    Preset: <strong>{activePresetMatch.name}</strong>
                  </>
                ) : selectedPreset ? (
                  <>
                    Modified from <strong>{selectedPreset.name}</strong>
                  </>
                ) : (
                  'Custom configuration'
                )}
              </div>
              <p className="settings-hint">
                Choosing a preset applies it immediately. Settings update live while this panel is open.
              </p>
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Cpu size={14} />
              <span>Debate Models</span>
            </label>
            <div className="model-list">
              {models.map((model, i) => (
                <div key={i} className="model-item">
                  <span className="model-item-name">{model}</span>
                  <button
                    className="model-item-remove"
                    onClick={() => removeModel(i)}
                    disabled={models.length <= 1}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={newModelProvider}
                onChange={e => setNewModelProvider(e.target.value)}
                disabled={providerOptions.length === 0}
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
              />
              <button
                className="model-add-btn"
                onClick={addModel}
                disabled={providerOptions.length === 0}
              >
                <Plus size={14} />
                Add
              </button>
              {providerOptions.length > 0 && (
                <button
                  className="model-browse-btn"
                  onClick={() => setPickerOpen('debate')}
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
                <span>Smart Ranking</span>
              </label>
              <div className="model-add-row">
                <select
                  className="settings-input settings-select"
                  value={rankingMode}
                  onChange={e => setRankingMode(e.target.value)}
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
                >
                  Use Top 3
                </button>
              </div>
              <div className="settings-smart-ranking-options">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={rankingPreferFlagship}
                    onChange={e => setRankingPreferFlagship(e.target.checked)}
                  />
                  <span>Prioritize flagship model families</span>
                </label>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={rankingPreferNew}
                    onChange={e => setRankingPreferNew(e.target.checked)}
                  />
                  <span>Boost newly released/discovered models</span>
                </label>
                <label className="settings-checkbox">
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
                    <button
                      key={item.modelId}
                      className="settings-ranked-item"
                      onClick={() => addModelId(item.modelId)}
                      disabled={models.includes(item.modelId)}
                      title={models.includes(item.modelId) ? 'Already selected' : `Score ${item.score}`}
                    >
                      <span>{item.modelId}</span>
                      <span>{item.score}</span>
                    </button>
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

          <div className="settings-section">
            <label className="settings-label">
              <Sparkles size={14} />
              <span>Synthesizer Model</span>
            </label>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={synthProvider}
                onChange={e => setSynthProvider(e.target.value)}
                disabled={providerOptions.length === 0}
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
                list={getProviderModelOptions(synthProvider).length > 0 ? `provider-models-synth-${synthProvider}` : undefined}
              />
              <button
                className="model-browse-btn"
                onClick={() => setPickerOpen('synth')}
              >
                Browse
              </button>
            </div>
            {getProviderModelOptions(synthProvider).length > 0 && (
              <datalist id={`provider-models-synth-${synthProvider}`}>
                {getProviderModelOptions(synthProvider).slice(0, 200).map((modelId) => (
                  <option key={modelId} value={modelId} />
                ))}
              </datalist>
            )}
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <GitCompareArrows size={14} />
              <span>Convergence Check Model</span>
            </label>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={convProvider}
                onChange={e => setConvProvider(e.target.value)}
                disabled={providerOptions.length === 0}
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
                list={getProviderModelOptions(convProvider).length > 0 ? `provider-models-conv-${convProvider}` : undefined}
              />
              <button
                className="model-browse-btn"
                onClick={() => setPickerOpen('convergence')}
              >
                Browse
              </button>
            </div>
            {getProviderModelOptions(convProvider).length > 0 && (
              <datalist id={`provider-models-conv-${convProvider}`}>
                {getProviderModelOptions(convProvider).slice(0, 200).map((modelId) => (
                  <option key={modelId} value={modelId} />
                ))}
              </datalist>
            )}
            <p className="settings-hint">
              A fast model used to check if debaters have reached consensus between rounds.
            </p>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Globe size={14} />
              <span>Web Search Model</span>
            </label>
            <div className="model-add-row">
              <select
                className="settings-input settings-select"
                value={searchProvider}
                onChange={e => setSearchProvider(e.target.value)}
                disabled={providerOptions.length === 0}
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
                list={getProviderModelOptions(searchProvider).length > 0 ? `provider-models-search-${searchProvider}` : undefined}
              />
              <button
                className="model-browse-btn"
                onClick={() => setPickerOpen('search')}
              >
                Browse
              </button>
            </div>
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
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={strictSearch}
                onChange={e => setStrictSearch(e.target.checked)}
              />
              <span>Strict search verification (block unverified answers)</span>
            </label>
            <p className="settings-hint">
              Requires source URLs and date evidence on Search-enabled first-round responses. If missing, the app auto-retries with legacy search context.
            </p>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Shield size={14} />
              <span>Retry & Resilience</span>
            </label>
            <div className="settings-grid-compact">
              <label className="settings-inline-field">
                <span>Max attempts</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  className="settings-input"
                  value={retryMaxAttempts}
                  onChange={e => setRetryMaxAttempts(Number(e.target.value))}
                />
              </label>
              <label className="settings-inline-field">
                <span>Base delay (ms)</span>
                <input
                  type="number"
                  min={100}
                  max={10000}
                  step={100}
                  className="settings-input"
                  value={retryBaseDelayMs}
                  onChange={e => setRetryBaseDelayMs(Number(e.target.value))}
                />
              </label>
              <label className="settings-inline-field">
                <span>Max delay (ms)</span>
                <input
                  type="number"
                  min={retryBaseDelayMs || 100}
                  max={30000}
                  step={100}
                  className="settings-input"
                  value={retryMaxDelayMs}
                  onChange={e => setRetryMaxDelayMs(Number(e.target.value))}
                />
              </label>
              <label className="settings-inline-field">
                <span>Circuit failures</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="settings-input"
                  value={circuitFailureThreshold}
                  onChange={e => setCircuitFailureThreshold(Number(e.target.value))}
                />
              </label>
              <label className="settings-inline-field">
                <span>Cooldown (ms)</span>
                <input
                  type="number"
                  min={5000}
                  max={600000}
                  step={1000}
                  className="settings-input"
                  value={circuitCooldownMs}
                  onChange={e => setCircuitCooldownMs(Number(e.target.value))}
                />
              </label>
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Activity size={14} />
              <span>Diagnostics</span>
            </label>
            <p className="settings-hint">
              Global browser-level telemetry for provider failures and retry behavior. Useful for debugging routes and outages, not for judging answer quality.
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
                  >
                    Reset Diagnostics
                  </button>
                </div>
              </>
            ) : (
              <p className="settings-hint">No diagnostics have been collected in this browser profile yet.</p>
            )}
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <DollarSign size={14} />
              <span>Budget Guardrails</span>
            </label>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={budgetEnabled}
                onChange={e => setBudgetEnabled(e.target.checked)}
              />
              <span>Require confirmation for expensive prompts</span>
            </label>
            <div className="settings-grid-compact">
              <label className="settings-inline-field">
                <span>Soft limit (USD)</span>
                <input
                  type="number"
                  min={0}
                  step={0.05}
                  className="settings-input"
                  value={budgetSoftLimit}
                  onChange={e => setBudgetSoftLimit(Number(e.target.value))}
                  disabled={!budgetEnabled}
                />
              </label>
              <label className="settings-inline-field">
                <span>Auto-approve below</span>
                <input
                  type="number"
                  min={0}
                  step={0.05}
                  className="settings-input"
                  value={budgetAutoApprove}
                  onChange={e => setBudgetAutoApprove(Number(e.target.value))}
                  disabled={!budgetEnabled}
                />
              </label>
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Gauge size={14} />
              <span>Performance</span>
            </label>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={virtualizationEnabled}
                onChange={e => setVirtualizationEnabled(e.target.checked)}
              />
              <span>Virtualize older rounds for faster rendering</span>
            </label>
            <label className="settings-inline-field">
              <span>Keep latest rounds</span>
              <input
                type="number"
                min={2}
                max={12}
                className="settings-input"
                value={virtualizationKeepLatest}
                onChange={e => setVirtualizationKeepLatest(Number(e.target.value))}
                disabled={!virtualizationEnabled}
              />
            </label>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Database size={14} />
              <span>Response Cache</span>
            </label>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={cachePersistence}
                onChange={e => setCachePersistence(e.target.checked)}
              />
              <span>Persist cache across app restarts</span>
            </label>
            <div className="settings-cache-row">
              <span className="settings-hint">
                Hits: <strong>{cacheHitCount}</strong> · Entries: <strong>{cacheEntryCount}</strong>
              </span>
              <button
                className="settings-btn-secondary"
                onClick={clearResponseCache}
                type="button"
              >
                Clear Cache
              </button>
            </div>
          </div>

          <div className="settings-divider" />

          <div className="settings-section">
            <label className="settings-label">
              <RotateCcw size={14} />
              <span>Max Debate Rounds</span>
            </label>
            <div className="slider-row">
              <input
                type="range"
                className="settings-slider"
                min={1}
                max={10}
                value={maxRounds}
                onChange={e => setMaxRounds(Number(e.target.value))}
              />
              <span className="slider-value">{maxRounds}</span>
            </div>
            <p className="settings-hint">
              {maxRounds === 1
                ? 'Single round - models respond once, then synthesis.'
                : `Up to ${maxRounds} rounds - models debate and refine positions.`}
            </p>
            <label className="settings-checkbox">
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
        </div>

        <div className="settings-footer">
          <button className="settings-btn-secondary" onClick={resetDefaults}>
            Reset Defaults
          </button>
          <button
            className="settings-btn-primary"
            onClick={handleSave}
          >
            Done
          </button>
        </div>
        {presetSheet && (
          <div className="settings-sheet-backdrop" onClick={closePresetSheet}>
            <div className="settings-sheet glass-panel" onClick={(event) => event.stopPropagation()}>
              <div className="settings-sheet-header">
                <h3>{presetSheet.title}</h3>
                <button className="settings-close" onClick={closePresetSheet}>
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

