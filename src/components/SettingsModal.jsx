import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Key, Cpu, Sparkles, Plus, Trash2, RotateCcw, GitCompareArrows, Globe } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import {
  DEFAULT_DEBATE_MODELS,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_CONVERGENCE_MODEL,
  DEFAULT_MAX_DEBATE_ROUNDS,
  DEFAULT_WEB_SEARCH_MODEL,
} from '../lib/openrouter';
import ModelPickerModal from './ModelPickerModal';
import './SettingsModal.css';

export default function SettingsModal() {
  const {
    apiKey, selectedModels, synthesizerModel,
    convergenceModel, maxDebateRounds, webSearchModel, strictWebSearch,
    showSettings, rememberApiKey, providerStatus, providerStatusState, providerStatusError, modelCatalog, modelCatalogStatus, modelPresets, dispatch,
  } = useDebate();
  const [keyInput, setKeyInput] = useState(apiKey);
  const [models, setModels] = useState(selectedModels);
  const [synth, setSynth] = useState(synthesizerModel);
  const [convModel, setConvModel] = useState(convergenceModel);
  const [maxRounds, setMaxRounds] = useState(maxDebateRounds);
  const [searchModel, setSearchModel] = useState(webSearchModel);
  const [strictSearch, setStrictSearch] = useState(strictWebSearch);
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
    dispatch({ type: 'SET_MAX_DEBATE_ROUNDS', payload: maxRounds });
    dispatch({ type: 'SET_WEB_SEARCH_MODEL', payload: normalizedSearch || searchModel.trim() });
    dispatch({ type: 'SET_STRICT_WEB_SEARCH', payload: strictSearch });
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
    setMaxRounds(DEFAULT_MAX_DEBATE_ROUNDS);
    setSearchModel(DEFAULT_WEB_SEARCH_MODEL);
    setStrictSearch(false);
  };

  useEffect(() => {
    if (!showSettings) return;
    setKeyInput(apiKey);
    setModels(selectedModels);
    setSynth(synthesizerModel);
    setConvModel(convergenceModel);
    setMaxRounds(maxDebateRounds);
    setSearchModel(webSearchModel);
    setStrictSearch(strictWebSearch);
    setRememberKey(rememberApiKey);
    setPresetName('');
    setEditingPresetId(null);
    setSynthProvider(getDirectProviderFromValue(synthesizerModel));
    setConvProvider(getDirectProviderFromValue(convergenceModel));
    setSearchProvider(getDirectProviderFromValue(webSearchModel));
  }, [showSettings, apiKey, selectedModels, synthesizerModel, convergenceModel, maxDebateRounds, webSearchModel, strictWebSearch, rememberApiKey]);

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
                ? 'Single round — models respond once, then synthesis.'
                : `Up to ${maxRounds} rounds — models debate and refine positions.`}
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

