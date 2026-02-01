import { useState } from 'react';
import { X, Key, Cpu, Sparkles, Plus, Trash2, RotateCcw, GitCompareArrows, Globe } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import {
  DEFAULT_DEBATE_MODELS,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_CONVERGENCE_MODEL,
  DEFAULT_MAX_DEBATE_ROUNDS,
  DEFAULT_WEB_SEARCH_MODEL,
} from '../lib/openrouter';
import './SettingsModal.css';

export default function SettingsModal() {
  const {
    apiKey, selectedModels, synthesizerModel,
    convergenceModel, maxDebateRounds, webSearchModel,
    showSettings, dispatch,
  } = useDebate();
  const [keyInput, setKeyInput] = useState(apiKey);
  const [models, setModels] = useState(selectedModels);
  const [synth, setSynth] = useState(synthesizerModel);
  const [convModel, setConvModel] = useState(convergenceModel);
  const [maxRounds, setMaxRounds] = useState(maxDebateRounds);
  const [searchModel, setSearchModel] = useState(webSearchModel);
  const [newModel, setNewModel] = useState('');

  if (!showSettings) return null;

  const handleSave = () => {
    dispatch({ type: 'SET_API_KEY', payload: keyInput.trim() });
    dispatch({ type: 'SET_MODELS', payload: models });
    dispatch({ type: 'SET_SYNTHESIZER', payload: synth });
    dispatch({ type: 'SET_CONVERGENCE_MODEL', payload: convModel });
    dispatch({ type: 'SET_MAX_DEBATE_ROUNDS', payload: maxRounds });
    dispatch({ type: 'SET_WEB_SEARCH_MODEL', payload: searchModel });
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: false });
  };

  const handleClose = () => {
    if (!apiKey) return; // Don't close if no API key set
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: false });
  };

  const addModel = () => {
    const trimmed = newModel.trim();
    if (trimmed && !models.includes(trimmed)) {
      setModels([...models, trimmed]);
      setNewModel('');
    }
  };

  const removeModel = (index) => {
    if (models.length <= 1) return;
    setModels(models.filter((_, i) => i !== index));
  };

  const resetDefaults = () => {
    setModels(DEFAULT_DEBATE_MODELS);
    setSynth(DEFAULT_SYNTHESIZER_MODEL);
    setConvModel(DEFAULT_CONVERGENCE_MODEL);
    setMaxRounds(DEFAULT_MAX_DEBATE_ROUNDS);
    setSearchModel(DEFAULT_WEB_SEARCH_MODEL);
  };

  return (
    <div className="settings-overlay" onClick={handleClose}>
      <div className="settings-modal glass-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          {apiKey && (
            <button className="settings-close" onClick={handleClose}>
              <X size={18} />
            </button>
          )}
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <label className="settings-label">
              <Key size={14} />
              <span>OpenRouter API Key</span>
            </label>
            <input
              type="password"
              className="settings-input"
              placeholder="sk-or-..."
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              autoFocus={!apiKey}
            />
            <p className="settings-hint">
              Get your key at{' '}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                openrouter.ai/keys
              </a>
            </p>
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
              <input
                type="text"
                className="settings-input"
                placeholder="provider/model-name"
                value={newModel}
                onChange={e => setNewModel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addModel()}
              />
              <button className="model-add-btn" onClick={addModel}>
                <Plus size={14} />
                Add
              </button>
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Sparkles size={14} />
              <span>Synthesizer Model</span>
            </label>
            <input
              type="text"
              className="settings-input"
              placeholder="openai/gpt-4o"
              value={synth}
              onChange={e => setSynth(e.target.value)}
            />
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

          <div className="settings-section">
            <label className="settings-label">
              <GitCompareArrows size={14} />
              <span>Convergence Check Model</span>
            </label>
            <input
              type="text"
              className="settings-input"
              placeholder="google/gemini-2.0-flash-exp"
              value={convModel}
              onChange={e => setConvModel(e.target.value)}
            />
            <p className="settings-hint">
              A fast model used to check if debaters have reached consensus between rounds.
            </p>
          </div>

          <div className="settings-section">
            <label className="settings-label">
              <Globe size={14} />
              <span>Web Search Model</span>
            </label>
            <input
              type="text"
              className="settings-input"
              placeholder="perplexity/sonar"
              value={searchModel}
              onChange={e => setSearchModel(e.target.value)}
            />
            <p className="settings-hint">
              A model with web search capabilities (e.g. Perplexity Sonar via OpenRouter). Used when the Search toggle is active.
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
            disabled={!keyInput.trim()}
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}
