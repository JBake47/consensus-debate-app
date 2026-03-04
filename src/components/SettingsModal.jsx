import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Key, Cpu, Sparkles, Plus, Trash2, RotateCcw, GitCompareArrows, Globe, Shield, DollarSign, Wand2, Gauge, Database } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
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

export default function SettingsModal() {
  const {
    apiKey, selectedModels, synthesizerModel,
    convergenceModel, convergenceOnFinalRound, maxDebateRounds, webSearchModel, strictWebSearch,
    retryPolicy, budgetGuardrailsEnabled, budgetSoftLimitUsd, budgetAutoApproveBelowUsd,
    smartRankingMode, smartRankingPreferFlagship, smartRankingPreferNew, smartRankingAllowPreview,
    streamVirtualizationEnabled, streamVirtualizationKeepLatest,
    cachePersistenceEnabled, cacheHitCount, cacheEntryCount,
    showSettings, rememberApiKey, providerStatus, providerStatusState, providerStatusError, modelCatalog, modelCatalogStatus, modelPresets, metrics, clearResponseCache, dispatch,
  } = useDebate();
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
  const [newModel, setNewModel] = useState('');
  const [newModelProvider, setNewModelProvider] = useState('openrouter');
  const [pickerOpen, setPickerOpen] = useState(null);
  const [presetName, setPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState(null);
  const [expandedPresets, setExpandedPresets] = useState([]);
  const [synthProvider, setSynthProvider] = useState('openrouter');
  const [convProvider, setConvProvider] = useState('openrouter');
  const [searchProvider, setSearchProvider] = useState('openrouter');
  const presetNameInputRef = useRef(null);

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

  const handleSave = () => {
    const normalizedSynth = normalizeModelForProvider(synthProvider, synth);
    const normalizedConvergence = normalizeModelForProvider(convProvider, convModel);
    const normalizedSearch = normalizeModelForProvider(searchProvider, searchModel);

    dispatch({ type: 'SET_REMEMBER_API_KEY', payload: rememberKey });
    dispatch({ type: 'SET_API_KEY', payload: keyInput.trim() });
    dispatch({ type: 'SET_MODELS', payload: models });
    dispatch({ type: 'SET_SYNTHESIZER', payload: normalizedSynth || synth.trim() });
    dispatch({ type: 'SET_CONVERGENCE_MODEL', payload: normalizedConvergence || convModel.trim() });
    dispatch({ type: 'SET_CONVERGENCE_ON_FINAL_ROUND', payload: convOnFinalRound });
    dispatch({ type: 'SET_MAX_DEBATE_ROUNDS', payload: maxRounds });
    dispatch({ type: 'SET_WEB_SEARCH_MODEL', payload: normalizedSearch || searchModel.trim() });
    dispatch({ type: 'SET_STRICT_WEB_SEARCH', payload: strictSearch });
    dispatch({
      type: 'SET_RETRY_POLICY',
      payload: {
        maxAttempts: retryMaxAttempts,
        baseDelayMs: retryBaseDelayMs,
        maxDelayMs: retryMaxDelayMs,
        circuitFailureThreshold,
        circuitCooldownMs,
      },
    });
    dispatch({ type: 'SET_BUDGET_GUARDRAILS_ENABLED', payload: budgetEnabled });
    dispatch({ type: 'SET_BUDGET_SOFT_LIMIT_USD', payload: budgetSoftLimit });
    dispatch({ type: 'SET_BUDGET_AUTO_APPROVE_BELOW_USD', payload: budgetAutoApprove });
    dispatch({ type: 'SET_SMART_RANKING_MODE', payload: rankingMode });
    dispatch({ type: 'SET_SMART_RANKING_PREFER_FLAGSHIP', payload: rankingPreferFlagship });
    dispatch({ type: 'SET_SMART_RANKING_PREFER_NEW', payload: rankingPreferNew });
    dispatch({ type: 'SET_SMART_RANKING_ALLOW_PREVIEW', payload: rankingAllowPreview });
    dispatch({ type: 'SET_STREAM_VIRTUALIZATION_ENABLED', payload: virtualizationEnabled });
    dispatch({ type: 'SET_STREAM_VIRTUALIZATION_KEEP_LATEST', payload: virtualizationKeepLatest });
    dispatch({ type: 'SET_CACHE_PERSISTENCE_ENABLED', payload: cachePersistence });
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: false });
  };

  const handleClose = () => {
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
  const editingPreset = useMemo(
    () => modelPresets.find(p => p.id === editingPresetId) || null,
    [modelPresets, editingPresetId]
  );
  const canSavePreset = models.length > 0 && (
    editingPresetId
      ? Boolean(presetName.trim() || editingPreset?.name)
      : Boolean(presetName.trim())
  );

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
    if (!providerOptions.find(p => p.id === newModelProvider) && providerOptions.length > 0) {
      setNewModelProvider(providerOptions[0].id);
    }
  }, [providerOptions, newModelProvider]);

  useEffect(() => {
    if (!editingPresetId) return;
    const input = presetNameInputRef.current;
    if (!input) return;
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }, [editingPresetId]);

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

  const savePreset = () => {
    const nameValue = editingPresetId ? (presetName.trim() || editingPreset?.name || '') : presetName;
    const payload = buildPresetPayload(nameValue);
    if (!payload) return;

    if (editingPresetId) {
      dispatch({
        type: 'UPDATE_MODEL_PRESET',
        payload: { id: editingPresetId, ...payload },
      });
    } else {
      dispatch({
        type: 'ADD_MODEL_PRESET',
        payload,
      });
    }

    setPresetName('');
    setEditingPresetId(null);
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

  const usePreset = (preset) => {
    loadPresetValues(preset);
    setEditingPresetId(null);
    setPresetName('');
  };

  const editPreset = (preset) => {
    loadPresetValues(preset);
    setPresetName(preset.name || '');
    setEditingPresetId(preset.id);
    setExpandedPresets((prev) => (prev.includes(preset.id) ? prev : [...prev, preset.id]));
  };

  const cancelPresetEdit = () => {
    setEditingPresetId(null);
    setPresetName('');
  };

  const deletePreset = (presetId) => {
    dispatch({ type: 'DELETE_MODEL_PRESET', payload: presetId });
    if (editingPresetId === presetId) {
      setEditingPresetId(null);
      setPresetName('');
    }
  };

  const togglePreset = (presetId) => {
    setExpandedPresets((prev) => (
      prev.includes(presetId)
        ? prev.filter(id => id !== presetId)
        : [...prev, presetId]
    ));
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
    setPresetName('');
    setEditingPresetId(null);
    setSynthProvider(getDirectProviderFromValue(synthesizerModel));
    setConvProvider(getDirectProviderFromValue(convergenceModel));
    setSearchProvider(getDirectProviderFromValue(webSearchModel));
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
            <div className="preset-row">
              <input
                ref={presetNameInputRef}
                type="text"
                className="settings-input"
                placeholder="Preset name (e.g. fast, deep-reasoning)"
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && savePreset()}
              />
              <button
                className="model-add-btn"
                onClick={savePreset}
                disabled={!canSavePreset}
              >
                <Plus size={14} />
                {editingPresetId ? 'Save Preset Edit' : 'Save New Preset'}
              </button>
              {editingPresetId && (
                <button
                  className="settings-btn-secondary"
                  onClick={cancelPresetEdit}
                >
                  Cancel Edit
                </button>
              )}
            </div>
            {editingPreset ? (
              <div className="preset-edit-banner">
                <div className="preset-edit-title">
                  Editing preset: <strong>{editingPreset.name}</strong>
                </div>
                <div className="preset-edit-text">
                  Click <strong>Save Preset Edit</strong> to save this preset only. Use <strong>Save Settings</strong> separately to apply app settings.
                </div>
                <div className="preset-edit-actions">
                  <button
                    className="model-add-btn"
                    onClick={savePreset}
                    disabled={!canSavePreset}
                  >
                    Save This Preset
                  </button>
                  <button
                    className="settings-btn-secondary"
                    onClick={cancelPresetEdit}
                  >
                    Cancel Edit
                  </button>
                </div>
              </div>
            ) : (
              <p className="settings-hint">
                Click <strong>Edit</strong> on a preset to load it into the form before updating.
              </p>
            )}
            {modelPresets && modelPresets.length > 0 ? (
              <div className="preset-list">
                {modelPresets.map((preset) => (
                  <div
                    key={preset.id}
                    className={`preset-item ${editingPresetId === preset.id ? 'is-editing' : ''}`}
                  >
                    <div className="preset-summary">
                      <div className="preset-info">
                        <span className="preset-name">{preset.name}</span>
                        <span className="preset-count">{preset.models.length} models</span>
                      </div>
                      <div className="preset-actions">
                        <button className="model-add-btn" onClick={() => usePreset(preset)}>
                          Load
                        </button>
                        <button
                          className={`settings-btn-secondary ${editingPresetId === preset.id ? 'preset-editing-btn' : ''}`}
                          onClick={() => editPreset(preset)}
                        >
                          {editingPresetId === preset.id ? 'Editing Now' : 'Edit'}
                        </button>
                        <button
                          className="settings-btn-secondary preset-details-btn"
                          onClick={() => togglePreset(preset.id)}
                        >
                          {expandedPresets.includes(preset.id) ? 'Hide' : 'Details'}
                        </button>
                        <button className="model-item-remove" onClick={() => deletePreset(preset.id)} title="Delete preset">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    {expandedPresets.includes(preset.id) && (
                      <div className="preset-details">
                        <div className="preset-detail-row">
                          <span className="preset-detail-label">Models</span>
                          <div className="preset-model-list">
                            {preset.models.map((modelId, index) => (
                              <code key={`${preset.id}-${modelId}-${index}`} className="preset-model-chip">
                                {modelId}
                              </code>
                            ))}
                          </div>
                        </div>
                        <div className="preset-detail-grid">
                          <div className="preset-detail-row">
                            <span className="preset-detail-label">Synthesizer</span>
                            <span className="preset-detail-value preset-detail-value-mono">{preset.synthesizerModel || '-'}</span>
                          </div>
                          <div className="preset-detail-row">
                            <span className="preset-detail-label">Convergence</span>
                            <span className="preset-detail-value preset-detail-value-mono">{preset.convergenceModel || '-'}</span>
                          </div>
                          <div className="preset-detail-row">
                            <span className="preset-detail-label">Web Search</span>
                            <span className="preset-detail-value preset-detail-value-mono">{preset.webSearchModel || '-'}</span>
                          </div>
                          <div className="preset-detail-row">
                            <span className="preset-detail-label">Max Rounds</span>
                            <span className="preset-detail-value">{preset.maxDebateRounds || '-'}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="settings-hint">Save a preset to quickly switch model lineups.</p>
            )}
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
            Save Settings
          </button>
        </div>
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

