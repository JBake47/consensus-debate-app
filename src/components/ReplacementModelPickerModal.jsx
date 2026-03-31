import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Sparkles, X } from 'lucide-react';
import { useDebateConversations, useDebateSettings } from '../context/DebateContext';
import { getModelDisplayName, getProviderName } from '../lib/openrouter';
import { buildRankingTaskRequirements } from '../lib/modelRanking';
import { getModelStatRows, resolveModelCatalogEntry } from '../lib/modelStats';
import { buildModelWorkloadProfile } from '../lib/modelWorkload';
import { getReplacementModelChoices, getRetryScopeDescription } from '../lib/retryState';
import './ReplacementModelPickerModal.css';

const DEFAULT_VISIBLE_CHOICES = 60;

function buildScopeSummary(turnMode, roundNumber, totalRounds, currentModel, branchesConversation = false) {
  const scopeDescription = getRetryScopeDescription({
    scope: 'stream',
    mode: turnMode,
    roundNumber,
    totalRounds,
    modelName: getModelDisplayName(currentModel),
    replacementModelName: 'another model',
    branchesConversation,
  });
  const parts = scopeDescription.split('. ');
  return parts.length > 1 ? parts.slice(1).join('. ') : scopeDescription;
}

function formatDurationCompact(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatChoiceTelemetry(choice) {
  const requestCount = Number(choice?.telemetry?.requestCount || 0);
  const qualityVotes = Number(choice?.qualityBreakdown?.feedback?.voteCount || 0);
  const feedbackSummary = String(choice?.qualityBreakdown?.feedback?.summary || '').trim();
  const benchmarkLabel = String(choice?.qualityBreakdown?.benchmark?.label || '').trim();
  const parts = [];

  if (qualityVotes > 0 && feedbackSummary) {
    parts.push(`Judge ${feedbackSummary}`);
  } else if (benchmarkLabel) {
    parts.push(benchmarkLabel);
  }

  if (requestCount > 0) {
    parts.push(`Success ${choice.telemetry.successRatePct}% across ${requestCount} run${requestCount === 1 ? '' : 's'}`);
    parts.push(`p50 ${formatDurationCompact(choice.telemetry.p50FirstTokenMs)}`);
    parts.push(`cache ${choice.telemetry.cacheHitRatePct}%`);
  } else if (parts.length === 0) {
    parts.push('No direct telemetry yet. Ranked from benchmark priors and catalog metadata.');
  }

  return parts.join(' · ');
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
  branchesConversation = false,
  initialForceRefresh = false,
}) {
  const {
    modelCatalog,
    modelCatalogStatus,
    modelCatalogError,
    metrics,
    capabilityRegistry,
    smartRankingMode,
    smartRankingPreferFlagship,
    smartRankingPreferNew,
    smartRankingAllowPreview,
  } = useDebateSettings();
  const { activeConversation } = useDebateConversations();
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

  const currentTurn = activeConversation?.turns?.[activeConversation.turns.length - 1] || null;
  const taskRequirements = useMemo(() => buildRankingTaskRequirements({
    currentModel,
    modelCatalog,
    attachments: Array.isArray(currentTurn?.attachments) ? currentTurn.attachments : [],
    webSearchEnabled: Boolean(currentTurn?.webSearchEnabled),
  }), [currentModel, currentTurn?.attachments, currentTurn?.webSearchEnabled, modelCatalog]);

  const workloadProfile = useMemo(() => buildModelWorkloadProfile({
    turnMode,
    selectedModelCount: Math.max(1, roundModels.length || 1),
    maxDebateRounds: Math.max(1, totalRounds || 1),
    startRound: Number.isFinite(Number(roundNumber)) ? Number(roundNumber) : 1,
  }), [turnMode, roundModels.length, totalRounds, roundNumber]);

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
      capabilityRegistry,
      taskRequirements,
      workloadProfile,
    });
  }, [
    open,
    currentModel,
    roundModels,
    modelCatalog,
    modelCatalogStatus,
    metrics,
    capabilityRegistry,
    taskRequirements,
    workloadProfile,
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
  const scopeSummary = buildScopeSummary(turnMode, roundNumber, totalRounds, currentModel, branchesConversation);
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
          <button className="replacement-picker-close" onClick={onClose} aria-label="Close" type="button" title="Close the replacement model chooser.">
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
              title="Search candidate replacement models by ID, name, provider, or description."
            />
          </label>
          <label className="replacement-picker-cache-toggle" title="When enabled, the replacement run bypasses the local response cache and forces a fresh provider call.">
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
                  branchesConversation,
                });

                return (
                  <div key={choice.modelId} className="replacement-picker-item">
                    <div className="replacement-picker-info">
                      <div className="replacement-picker-row">
                        <span className="replacement-picker-provider">{providerName}</span>
                        <span className="replacement-picker-score" title={`Base score ${choice.score}`}>
                          Fit {choice.adjustedScore ?? choice.score}
                        </span>
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
                      {choice.highlights?.length > 0 && (
                        <div className="replacement-picker-highlights">
                          {choice.highlights.join(' · ')}
                        </div>
                      )}
                      {description && <div className="replacement-picker-description">{description}</div>}
                      <div className="replacement-picker-telemetry">
                        {formatChoiceTelemetry(choice)}
                      </div>
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
