import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Sparkles, X } from 'lucide-react';
import { useDebateSettings } from '../context/DebateContext';
import { getModelDisplayName, getProviderName } from '../lib/openrouter';
import { getModelStatRows, resolveModelCatalogEntry } from '../lib/modelStats';
import { getReplacementModelChoices, getRetryScopeDescription } from '../lib/retryState';
import './ReplacementModelPickerModal.css';

const DEFAULT_VISIBLE_CHOICES = 60;

function buildScopeSummary(turnMode, roundNumber, totalRounds, currentModel) {
  const scopeDescription = getRetryScopeDescription({
    scope: 'stream',
    mode: turnMode,
    roundNumber,
    totalRounds,
    modelName: getModelDisplayName(currentModel),
    replacementModelName: 'another model',
  });
  const parts = scopeDescription.split('. ');
  return parts.length > 1 ? parts.slice(1).join('. ') : scopeDescription;
}

export default function ReplacementModelPickerModal({
  open,
  onClose,
  onSelect,
  currentModel,
  roundModels = [],
  roundNumber = null,
  totalRounds = 1,
  turnMode = 'debate',
  initialForceRefresh = false,
}) {
  const {
    modelCatalog,
    modelCatalogStatus,
    modelCatalogError,
    metrics,
    smartRankingMode,
    smartRankingPreferFlagship,
    smartRankingPreferNew,
    smartRankingAllowPreview,
  } = useDebateSettings();
  const [query, setQuery] = useState('');
  const [forceRefresh, setForceRefresh] = useState(Boolean(initialForceRefresh));

  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setForceRefresh(Boolean(initialForceRefresh));
  }, [open, initialForceRefresh, currentModel]);

  const allChoices = useMemo(() => {
    if (!open || modelCatalogStatus !== 'ready') return [];
    return getReplacementModelChoices({
      currentModel,
      roundModels,
      modelCatalog,
      metrics,
      rankingMode: smartRankingMode,
      rankingPreferences: {
        preferFlagship: smartRankingPreferFlagship,
        preferNew: smartRankingPreferNew,
        allowPreview: smartRankingAllowPreview,
      },
    });
  }, [
    open,
    currentModel,
    roundModels,
    modelCatalog,
    modelCatalogStatus,
    metrics,
    smartRankingMode,
    smartRankingPreferFlagship,
    smartRankingPreferNew,
    smartRankingAllowPreview,
  ]);

  const filteredChoices = useMemo(() => {
    const needle = String(query || '').trim().toLowerCase();
    const filtered = needle
      ? allChoices.filter((choice) => {
        const { model } = resolveModelCatalogEntry(modelCatalog, choice.modelId);
        const haystack = [
          choice.modelId,
          model?.name,
          model?.description,
          getProviderName(choice.modelId),
          getModelDisplayName(choice.modelId),
        ]
          .filter(Boolean)
          .join('\n')
          .toLowerCase();
        return haystack.includes(needle);
      })
      : allChoices;
    return filtered.slice(0, DEFAULT_VISIBLE_CHOICES);
  }, [allChoices, modelCatalog, query]);

  if (!open) return null;

  const currentModelLabel = getModelDisplayName(currentModel);
  const scopeSummary = buildScopeSummary(turnMode, roundNumber, totalRounds, currentModel);
  const portalTarget = typeof document !== 'undefined'
    ? document.getElementById('chat-window-overlay-root')
    : null;
  const hiddenCount = Math.max(0, allChoices.length - filteredChoices.length);

  const content = (
    <div className="replacement-picker-overlay" onClick={onClose}>
      <div
        className="replacement-picker-modal glass-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose replacement model"
      >
        <div className="replacement-picker-header">
          <div className="replacement-picker-title-block">
            <h3>Choose Backup Model</h3>
            <p>
              Replace <strong>{currentModelLabel}</strong>. {scopeSummary}
            </p>
          </div>
          <button className="replacement-picker-close" onClick={onClose} aria-label="Close" type="button">
            <X size={16} />
          </button>
        </div>

        <div className="replacement-picker-toolbar">
          <label className="replacement-picker-search">
            <Search size={14} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models by id, name, provider, or description..."
            />
          </label>
          <label className="replacement-picker-cache-toggle">
            <input
              type="checkbox"
              checked={forceRefresh}
              onChange={(event) => setForceRefresh(event.target.checked)}
            />
            <span>Bypass cache</span>
          </label>
        </div>

        <div className="replacement-picker-body">
          {modelCatalogStatus === 'loading' && (
            <div className="replacement-picker-status">Loading model catalog...</div>
          )}
          {modelCatalogStatus === 'error' && (
            <div className="replacement-picker-status error">
              {modelCatalogError || 'Model catalog unavailable.'}
            </div>
          )}
          {modelCatalogStatus !== 'ready' && modelCatalogStatus !== 'loading' && modelCatalogStatus !== 'error' && (
            <div className="replacement-picker-status">
              Model catalog is not ready yet. Try again in a moment.
            </div>
          )}
          {modelCatalogStatus === 'ready' && filteredChoices.length === 0 && (
            <div className="replacement-picker-status">
              {allChoices.length === 0 ? 'No replacement models are available.' : 'No models matched your search.'}
            </div>
          )}
          {modelCatalogStatus === 'ready' && filteredChoices.length > 0 && (
            <div className="replacement-picker-list">
              {filteredChoices.map((choice) => {
                const { model } = resolveModelCatalogEntry(modelCatalog, choice.modelId);
                const statRows = getModelStatRows(model || {});
                const statMap = Object.fromEntries(statRows.map((stat) => [stat.key, stat]));
                const providerName = getProviderName(choice.modelId);
                const displayName = model?.name || getModelDisplayName(choice.modelId);
                const description = String(model?.description || '').trim();
                const selectTitle = getRetryScopeDescription({
                  scope: 'stream',
                  mode: turnMode,
                  roundNumber,
                  totalRounds,
                  modelName: currentModelLabel,
                  replacementModelName: getModelDisplayName(choice.modelId),
                });

                return (
                  <div key={choice.modelId} className="replacement-picker-item">
                    <div className="replacement-picker-info">
                      <div className="replacement-picker-row">
                        <span className="replacement-picker-provider">{providerName}</span>
                        <span className="replacement-picker-score">Score {choice.score}</span>
                        {choice.recommended && (
                          <span className="replacement-picker-badge recommended">
                            <Sparkles size={11} />
                            Recommended
                          </span>
                        )}
                        {choice.alreadyUsedInRound && (
                          <span className="replacement-picker-badge duplicate">Already in round</span>
                        )}
                        {!choice.alreadyUsedInRound && choice.sameProvider && (
                          <span className="replacement-picker-badge same-provider">Same provider</span>
                        )}
                      </div>
                      <div className="replacement-picker-name">{choice.modelId}</div>
                      <div className="replacement-picker-display-name">{displayName}</div>
                      {description && <div className="replacement-picker-description">{description}</div>}
                      <div className="replacement-picker-stats">
                        <div className="replacement-picker-stat" title={statMap.contextLength?.detail || 'Unavailable'}>
                          <span>Context</span>
                          <strong>{statMap.contextLength?.value || 'N/A'}</strong>
                        </div>
                        <div className="replacement-picker-stat" title={statMap.maxOutput?.detail || 'Unavailable'}>
                          <span>Max</span>
                          <strong>{statMap.maxOutput?.value || 'N/A'}</strong>
                        </div>
                        <div
                          className="replacement-picker-stat"
                          title={`Input ${statMap.inputPrice?.detail || 'Unavailable'} | Output ${statMap.outputPrice?.detail || 'Unavailable'}`}
                        >
                          <span>In / Out</span>
                          <strong>{`${statMap.inputPrice?.value || 'N/A'} / ${statMap.outputPrice?.value || 'N/A'}`}</strong>
                        </div>
                      </div>
                    </div>
                    <button
                      className="replacement-picker-select"
                      onClick={(event) => onSelect?.(choice.modelId, { forceRefresh: forceRefresh || event.shiftKey })}
                      title={`${selectTitle} Shift bypasses cache.`}
                      type="button"
                    >
                      Replace
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="replacement-picker-footer">
          <span>
            {modelCatalogStatus === 'ready' ? `${allChoices.length} candidate model${allChoices.length === 1 ? '' : 's'}` : 'Replacement model chooser'}
          </span>
          {hiddenCount > 0 && (
            <span>Showing first {filteredChoices.length}. Refine the search to narrow further.</span>
          )}
        </div>
      </div>
    </div>
  );

  return portalTarget ? createPortal(content, portalTarget) : content;
}
