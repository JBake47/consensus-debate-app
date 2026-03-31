import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { User, Globe, ChevronDown, ChevronUp, Loader2, AlertCircle, Pencil, RotateCcw, LayoutGrid, MessageSquare } from 'lucide-react';
import { useDebateActions, useDebateConversations, useDebateSettings } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import ExpandButton from './ExpandButton';
import ModelCard from './ModelCard';
import ReplaceModelButton from './ReplaceModelButton';
import RoundSection from './RoundSection';
import DebateThread from './DebateThread';
import DebateProgressBar from './DebateProgressBar';
import SynthesisView from './SynthesisView';
import EnsembleResultPanel from './EnsembleResultPanel';
import AttachmentCard from './AttachmentCard';
import InfoTip from './InfoTip';
import { getModelDisplayName } from '../lib/openrouter';
import { formatFullTimestamp } from '../lib/formatDate';
import { recordPreviewPointerDown, shouldExpandPreviewFromClick } from '../lib/previewExpand';
import {
  deriveRoundStatusFromStreams,
  getRetryScopeDescription,
  getStreamDisplayState,
  isRoundAttentionRequired,
} from '../lib/retryState';
import { buildAttachmentRoutingOverview } from '../lib/attachmentRouting';
import {
  computeTurnCostMeta,
  formatCostWithQuality,
  formatDuration,
  getCostQualityDescription,
} from '../lib/formatTokens';
import './DebateView.css';

const AttachmentViewer = lazy(() => import('./AttachmentViewer'));
const ResponseViewerModal = lazy(() => import('./ResponseViewerModal'));

function WebSearchPanel({ webSearchResult, canRetry = false, onRetry = null, branchesConversation = false }) {
  const [collapsed, setCollapsed] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);
  const previewPointerRef = useRef(null);
  const { status, content, model, error, durationMs } = webSearchResult;
  const canExpandViewer = !viewerOpen && Boolean(content) && status === 'complete';

  const openViewer = () => {
    setCollapsed(false);
    setViewerOpen(true);
  };

  const handlePreviewClick = (event) => {
    if (!canExpandViewer || !shouldExpandPreviewFromClick(event, previewPointerRef)) {
      return;
    }

    openViewer();
  };

  const panel = (
    <div className={`web-search-panel glass-panel ${status} ${viewerOpen ? 'fullscreen-panel' : ''}`}>
      <div
        className="web-search-header"
        onClick={() => status === 'complete' && setCollapsed(!collapsed)}
        title="Search stage for this turn. It gathers live web evidence before the model answers when Search is enabled."
      >
        <div className="web-search-header-left">
          <div className="web-search-label-group">
            <Globe size={14} className="web-search-icon" />
            <span className="web-search-label">Web Search</span>
            <InfoTip
              content={[
                'This stage gathers live web evidence before the models answer.',
                'It only appears when Search is enabled for the turn.',
              ]}
              label="Web search stage help"
            />
          </div>
          {model && <span className="web-search-model">{getModelDisplayName(model)}</span>}
        </div>
        <div className="web-search-header-right">
          {status === 'searching' && (
            <span className="web-search-badge searching">
              <Loader2 size={12} className="spinning" />
              Searching...
            </span>
          )}
          {status === 'complete' && (
            <>
              {canExpandViewer && <ExpandButton onClick={openViewer} />}
              {content && <CopyButton text={content} />}
              <span className="web-search-badge complete">Done</span>
              {durationMs != null && (
                <span className="web-search-duration">{formatDuration(durationMs)}</span>
              )}
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </>
          )}
          {status === 'error' && (
            <>
              <span className="web-search-badge error">
                <AlertCircle size={12} />
                Failed
              </span>
              {canRetry && (
                <button
                  className="web-search-retry-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.({ forceRefresh: event.shiftKey });
                  }}
                  title={`${getRetryScopeDescription({ scope: 'web_search', branchesConversation })} Shift bypasses cache.`}
                >
                  <RotateCcw size={12} />
                  <span>Retry</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {status === 'complete' && !collapsed && content && (
        <div
          className="web-search-content markdown-content scroll-preview"
          onPointerDown={(event) => recordPreviewPointerDown(previewPointerRef, event)}
          onClick={handlePreviewClick}
        >
          <MarkdownRenderer>{content}</MarkdownRenderer>
        </div>
      )}
      {status === 'error' && error && (
        <div className="web-search-error">{error}</div>
      )}
    </div>
  );

  return viewerOpen ? (
    <Suspense fallback={panel}>
      <ResponseViewerModal open={viewerOpen} onClose={() => setViewerOpen(false)} title="Web Search">
        {panel}
      </ResponseViewerModal>
    </Suspense>
  ) : panel;
}

function AttentionPanel({
  attentionStreams,
  canRetryFailures,
  retryAllFailed,
  retryStream,
  totalRounds,
  turnMode,
  branchesConversation = false,
}) {
  const getErrorDiagnostics = (message) => {
    if (!message) return { summary: 'Unknown error', action: null };
    const summary = String(message);
    const lowered = summary.toLowerCase();
    if (lowered.includes('aborted')) {
      return {
        summary,
        action: 'Check provider routing, model IDs, or API keys, then retry.',
      };
    }
    if (lowered.includes('strict web-search mode blocked')) {
      return {
        summary,
        action: 'Either retry with stronger evidence or disable strict web-search for this turn.',
      };
    }
    if (lowered.includes('cancelled') || lowered.includes('canceled')) {
      return {
        summary,
        action: 'The run was cancelled. Retry to resume from this round.',
      };
    }
    if (lowered.includes('401') || lowered.includes('unauthorized') || lowered.includes('invalid key')) {
      return {
        summary,
        action: 'Recheck API credentials in Settings.',
      };
    }
    if (lowered.includes('402') || lowered.includes('insufficient credits')) {
      return {
        summary,
        action: 'Provider credits are likely depleted. Add credits, then retry.',
      };
    }
    if (lowered.includes('429') || lowered.includes('rate limit')) {
      return {
        summary,
        action: 'Rate limited. Retry after a short delay or reduce parallel models.',
      };
    }
    if (lowered.includes('timeout') || lowered.includes('timed out') || lowered.includes('network')) {
      return {
        summary,
        action: 'Transient network issue. Retry now or use Shift+Retry to bypass cache.',
      };
    }
    if (lowered.includes('model not found') || lowered.includes('404')) {
      return {
        summary,
        action: 'The model may be unavailable. Pick another model in Settings.',
      };
    }
    if (lowered.includes('circuit open')) {
      return {
        summary,
        action: 'Provider circuit breaker is active; retry or wait for cooldown.',
      };
    }
    return { summary, action: null };
  };

  if (attentionStreams.length === 0) return null;

  return (
    <div className="turn-error-panel glass-panel">
      <div className="turn-error-header">
        <div className="turn-error-title">Attention needed</div>
        {canRetryFailures && (
          <button
            className="turn-error-retry-all-btn"
            onClick={(event) => retryAllFailed({ forceRefresh: event.shiftKey })}
            title={branchesConversation
              ? 'Repair the earliest warning or failed round in a new branch and rebuild forward. Shift bypasses cache.'
              : 'Repair the earliest warning or failed round and rebuild forward. Shift bypasses cache.'}
          >
            <RotateCcw size={12} />
            <span>Repair Earliest Round</span>
          </button>
        )}
      </div>
      {canRetryFailures && (
        <div className="turn-error-hint">Tip: hold Shift while retrying to bypass cache.</div>
      )}
      <div className="turn-error-list">
        {attentionStreams.map((failure, index) => {
          const diagnostics = getErrorDiagnostics(failure.error);
          const retryScope = getRetryScopeDescription({
            scope: 'stream',
            mode: turnMode,
            roundNumber: failure.roundNumber,
            totalRounds,
            modelName: getModelDisplayName(failure.model),
            branchesConversation,
          });

          return (
            <div key={`${failure.model}-${index}`} className="turn-error-item">
              <div className="turn-error-row">
                <span className="turn-error-model">{getModelDisplayName(failure.model)}</span>
                <div className="turn-error-actions">
                  {canRetryFailures && (
                    <button
                      className="turn-error-retry-btn"
                      onClick={(event) => retryStream(
                        failure.roundIndex,
                        failure.streamIndex,
                        { forceRefresh: event.shiftKey },
                      )}
                      title={`${retryScope} Shift bypasses cache.`}
                    >
                      <RotateCcw size={12} />
                      <span>Retry</span>
                    </button>
                  )}
                  {canRetryFailures && (
                    <ReplaceModelButton
                      className="turn-error-retry-btn secondary"
                      currentModel={failure.model}
                      roundModels={failure.roundModels}
                      roundIndex={failure.roundIndex}
                      streamIndex={failure.streamIndex}
                      roundNumber={failure.roundNumber}
                      totalRounds={totalRounds}
                      turnMode={turnMode}
                      branchesConversation={branchesConversation}
                      title={branchesConversation
                        ? `Choose a replacement model for ${getModelDisplayName(failure.model)} in a new branch. Shift starts with cache bypass enabled.`
                        : `Choose a replacement model for ${getModelDisplayName(failure.model)}. Shift starts with cache bypass enabled.`}
                    >
                      <span>Replace</span>
                    </ReplaceModelButton>
                  )}
                </div>
              </div>
              <span className={`turn-error-state ${failure.displayState.tone}`}>{failure.displayState.label}</span>
              <span className="turn-error-message">{diagnostics.summary}</span>
              {diagnostics.action && (
                <span className="turn-error-action">{diagnostics.action}</span>
              )}
              <span className="turn-error-scope">{retryScope}</span>
              {failure.routeInfo?.routed && (
                <span className="turn-error-route">
                  Routed to {getModelDisplayName(failure.routeInfo.fallbackModel || failure.model)}.
                </span>
              )}
              {failure.routeInfo?.reason && !failure.routeInfo?.routed && (
                <span className="turn-error-route">{failure.routeInfo.reason}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StageTabs({ tabs, activeTab, onChange, className = '' }) {
  if (tabs.length === 0) return null;

  return (
    <div className={`turn-stage-tabs ${className}`.trim()} role="tablist" aria-label="Turn stages">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-label={tab.title ? `${tab.label}. ${tab.title}` : tab.label}
          className={`turn-stage-tab ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
          title={tab.title}
        >
          <span>{tab.label}</span>
          {tab.count != null && (
            <span className="turn-stage-tab-count">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function normalizeViewMode(value) {
  return value === 'thread' ? 'thread' : 'cards';
}

function normalizeRebuttalDisplayMode(value) {
  return value === 'round' ? 'round' : 'sequential';
}

function getDefaultStageTab(turn) {
  if (Array.isArray(turn?.rounds) && turn.rounds.length > 0) {
    return 'initial-responses';
  }
  return turn?.webSearchResult ? 'web-search' : null;
}

function getPersistedTurnBreakdownState(turn) {
  const persisted = turn?.uiState?.turnBreakdown;
  return persisted && typeof persisted === 'object' ? persisted : null;
}

function getInitialTurnBreakdownState(turn, options = {}) {
  const persisted = getPersistedTurnBreakdownState(turn);
  const parsedActiveRebuttalRoundIndex = Number(persisted?.activeRebuttalRoundIndex);
  return {
    viewMode: normalizeViewMode(persisted?.viewMode),
    activeStageTab: typeof persisted?.activeStageTab === 'string'
      ? persisted.activeStageTab
      : getDefaultStageTab(turn),
    isTurnExplorerOpen: typeof persisted?.isTurnExplorerOpen === 'boolean'
      ? persisted.isTurnExplorerOpen
      : Boolean(options.defaultExplorerOpen),
    rebuttalDisplayMode: normalizeRebuttalDisplayMode(persisted?.rebuttalDisplayMode),
    activeRebuttalRoundIndex: Number.isFinite(parsedActiveRebuttalRoundIndex) && parsedActiveRebuttalRoundIndex >= 0
      ? Math.floor(parsedActiveRebuttalRoundIndex)
      : 0,
  };
}

function DebateView({ turn, index, isLastTurn, highlighted = false }) {
  const {
    dispatch,
    editLastTurn,
    retryLastTurn,
    retryStream,
    retryAllFailed,
    retryWebSearch,
  } = useDebateActions();
  const {
    streamVirtualizationEnabled,
    streamVirtualizationKeepLatest,
    modelCatalog,
    capabilityRegistry,
  } = useDebateSettings();
  const {
    activeConversationId,
    debateInProgress,
    activeConversationIsMostRecent,
  } = useDebateConversations();
  const hasRounds = turn.rounds && turn.rounds.length > 0;
  const isDirectMode = turn.mode === 'direct';
  const isParallelMode = turn.mode === 'parallel';
  const isEnsembleTurn = isDirectMode && (
    turn.ensembleResult != null ||
    (hasRounds && turn.rounds[0]?.streams?.length > 1)
  );
  const turnMode = turn.mode || (isDirectMode ? 'direct' : 'debate');
  const turnCostMeta = computeTurnCostMeta(turn);
  const turnCostLabel = formatCostWithQuality(turnCostMeta);
  const keepLatestRounds = Math.max(2, Number(streamVirtualizationKeepLatest) || 4);
  const turnAttachmentRouting = useMemo(() => {
    if (!Array.isArray(turn.attachments) || turn.attachments.length === 0) {
      return [];
    }
    if (Array.isArray(turn.attachmentRouting) && turn.attachmentRouting.length === turn.attachments.length) {
      return turn.attachmentRouting;
    }
    const turnModels = Array.isArray(turn.modelOverrides) && turn.modelOverrides.length > 0
      ? turn.modelOverrides
      : (turn.rounds?.[0]?.streams || []).map((stream) => stream.model).filter(Boolean);
    return buildAttachmentRoutingOverview({
      attachments: turn.attachments,
      models: turnModels,
      modelCatalog,
      capabilityRegistry,
    });
  }, [turn.attachments, turn.attachmentRouting, turn.modelOverrides, turn.rounds, modelCatalog, capabilityRegistry]);

  const attentionRoundIndices = Array.isArray(turn.rounds)
    ? turn.rounds
      .map((round, index) => (isRoundAttentionRequired(round) ? index : null))
      .filter((value) => value != null)
    : [];

  const attentionStreams = hasRounds
    ? turn.rounds.flatMap((round, roundIndex) =>
      (round.streams || [])
        .map((stream, streamIndex) => {
          const displayState = getStreamDisplayState(stream);
          if (displayState.tone !== 'warning' && displayState.tone !== 'error') {
            return null;
          }
          return {
            roundIndex,
            streamIndex,
            model: stream.model,
            error: stream.error || displayState.label,
            routeInfo: stream.routeInfo || null,
            displayState,
            roundNumber: round.roundNumber || roundIndex + 1,
            roundModels: (round.streams || []).map((item) => item.model),
          };
        })
        .filter(Boolean)
    )
    : [];
  const turnInstanceKey = `${activeConversationId || 'no-conv'}:${turn.id || 'turn'}:${Number.isInteger(index) ? index : 'na'}:${turn.timestamp || 0}`;
  const persistedTurnBreakdownState = getPersistedTurnBreakdownState(turn);
  const hasPersistedExplorerPreference = typeof persistedTurnBreakdownState?.isTurnExplorerOpen === 'boolean';
  const initialTurnBreakdownState = getInitialTurnBreakdownState(turn, {
    defaultExplorerOpen: attentionStreams.length > 0,
  });
  const [viewMode, setViewMode] = useState(() => initialTurnBreakdownState.viewMode);
  const [activeStageTab, setActiveStageTab] = useState(() => initialTurnBreakdownState.activeStageTab);
  const [isTurnExplorerOpen, setIsTurnExplorerOpen] = useState(() => initialTurnBreakdownState.isTurnExplorerOpen);
  const [rebuttalDisplayMode, setRebuttalDisplayMode] = useState(() => initialTurnBreakdownState.rebuttalDisplayMode);
  const [activeRebuttalRoundIndex, setActiveRebuttalRoundIndex] = useState(() => initialTurnBreakdownState.activeRebuttalRoundIndex);
  const [viewerAttachment, setViewerAttachment] = useState(null);

  const canRetryFailures = isLastTurn && !debateInProgress;
  const canRetryWebSearch = isLastTurn && !debateInProgress;
  const branchesConversation = isLastTurn && !activeConversationIsMostRecent;
  const showTabbedStages = !isDirectMode && hasRounds;
  const initialRoundEntries = hasRounds
    ? [{ round: turn.rounds[0], roundIndex: 0 }]
    : [];
  const rebuttalRoundEntries = hasRounds
    ? turn.rounds.slice(1).map((round, index) => ({ round, roundIndex: index + 1 }))
    : [];

  const stageTabs = useMemo(() => {
    if (!showTabbedStages) return [];

    const tabs = [];
    if (turn.webSearchResult) {
      tabs.push({
        id: 'web-search',
        label: 'Web Search',
        title: 'View the search-assisted evidence gathered before the models answered.',
      });
    }
    if (initialRoundEntries.length > 0) {
      tabs.push({
        id: 'initial-responses',
        label: 'Initial Responses',
        title: 'See the first response from each selected model before rebuttals start.',
      });
    }
    if (rebuttalRoundEntries.length > 0) {
      tabs.push({
        id: 'rebuttal-rounds',
        label: 'Rebuttal Rounds',
        count: rebuttalRoundEntries.length,
        title: 'Inspect later rounds where models react to one another and refine their positions.',
      });
    }
    return tabs;
  }, [showTabbedStages, turn.webSearchResult, initialRoundEntries.length, rebuttalRoundEntries.length]);

  const stageTabsKey = stageTabs.map((tab) => tab.id).join('|');

  useEffect(() => {
    const nextState = getInitialTurnBreakdownState(turn, {
      defaultExplorerOpen: attentionStreams.length > 0,
    });
    setViewMode(nextState.viewMode);
    setActiveStageTab(nextState.activeStageTab);
    setIsTurnExplorerOpen(nextState.isTurnExplorerOpen);
    setRebuttalDisplayMode(nextState.rebuttalDisplayMode);
    setActiveRebuttalRoundIndex(nextState.activeRebuttalRoundIndex);
  }, [turnInstanceKey]);

  useEffect(() => {
    if (stageTabs.length === 0) {
      setActiveStageTab(null);
      return;
    }

    const defaultTab = stageTabs.find((tab) => tab.id === 'initial-responses')?.id || stageTabs[0].id;
    setActiveStageTab((current) => (
      stageTabs.some((tab) => tab.id === current)
        ? current
        : defaultTab
    ));
  }, [stageTabs.length, stageTabsKey]);

  useEffect(() => {
    if (!hasPersistedExplorerPreference && attentionStreams.length > 0) {
      setIsTurnExplorerOpen(true);
    }
  }, [attentionStreams.length, hasPersistedExplorerPreference]);

  useEffect(() => {
    if (rebuttalRoundEntries.length === 0) {
      setActiveRebuttalRoundIndex(0);
      return;
    }

    setActiveRebuttalRoundIndex((current) => Math.min(current, rebuttalRoundEntries.length - 1));
  }, [rebuttalRoundEntries.length]);

  const turnBreakdownUiState = useMemo(() => ({
    isTurnExplorerOpen,
    activeStageTab,
    viewMode: normalizeViewMode(viewMode),
    rebuttalDisplayMode: normalizeRebuttalDisplayMode(rebuttalDisplayMode),
    activeRebuttalRoundIndex: Math.max(0, Math.floor(Number(activeRebuttalRoundIndex) || 0)),
  }), [
    isTurnExplorerOpen,
    activeStageTab,
    viewMode,
    rebuttalDisplayMode,
    activeRebuttalRoundIndex,
  ]);

  useEffect(() => {
    if (!showTabbedStages || !activeConversationId) {
      return;
    }
    if (!turn.id && !Number.isInteger(index)) {
      return;
    }

    const persisted = persistedTurnBreakdownState || {};
    const matchesPersistedState = (
      persisted.isTurnExplorerOpen === turnBreakdownUiState.isTurnExplorerOpen
      && persisted.activeStageTab === turnBreakdownUiState.activeStageTab
      && persisted.viewMode === turnBreakdownUiState.viewMode
      && persisted.rebuttalDisplayMode === turnBreakdownUiState.rebuttalDisplayMode
      && Number(persisted.activeRebuttalRoundIndex || 0) === turnBreakdownUiState.activeRebuttalRoundIndex
    );

    if (matchesPersistedState) {
      return;
    }

    dispatch({
      type: 'UPDATE_TURN_UI_STATE',
      payload: {
        conversationId: activeConversationId,
        turnId: turn.id || null,
        turnIndex: Number.isInteger(index) ? index : null,
        uiState: {
          turnBreakdown: turnBreakdownUiState,
        },
      },
    });
  }, [
    showTabbedStages,
    activeConversationId,
    turn.id,
    index,
    persistedTurnBreakdownState,
    turnBreakdownUiState,
    dispatch,
  ]);

  const renderRoundEntries = (entries, emptyMessage) => {
    if (entries.length === 0) {
      return <div className="turn-stage-empty">{emptyMessage}</div>;
    }

    const shouldVirtualizeEntries = (
      streamVirtualizationEnabled
      && viewMode === 'cards'
      && entries.length > Math.max(6, keepLatestRounds + 1)
    );

    if (viewMode === 'thread') {
      return (
        <DebateThread
          rounds={entries.map((entry) => entry.round)}
          isLastTurn={isLastTurn}
          allowRetry
          turnMode={turnMode}
          totalRounds={turn.rounds.length}
          branchesConversation={branchesConversation}
        />
      );
    }

    return (
      <div className="debate-rounds">
        {shouldVirtualizeEntries && (
          <div className="debate-virtualized-banner">
            <span>
              Large round list virtualized automatically.
              {attentionRoundIndices.length > 0 && ` ${attentionRoundIndices.length} round${attentionRoundIndices.length !== 1 ? 's' : ''} currently need attention.`}
            </span>
          </div>
        )}
        {shouldVirtualizeEntries ? (
          <Virtuoso
            className="debate-rounds-virtuoso"
            style={{ height: 'min(72vh, 960px)' }}
            data={entries}
            increaseViewportBy={{ top: 500, bottom: 700 }}
            computeItemKey={(index, entry) => `${entry.round.roundNumber}-${entry.roundIndex}-${index}`}
            itemContent={(index, entry) => (
              <div className="debate-rounds-item">
                <RoundSection
                  round={entry.round}
                  isLatest={entry.roundIndex === turn.rounds.length - 1}
                  roundIndex={entry.roundIndex}
                  isLastTurn={isLastTurn}
                  allowRetry
                  allowRoundRetry={!isParallelMode}
                  allowStreamRetry
                  turnMode={turnMode}
                  totalRounds={turn.rounds.length}
                  branchesConversation={branchesConversation}
                />
              </div>
            )}
          />
        ) : (
          entries.map((entry) => (
            <RoundSection
              key={`${activeStageTab}-${entry.round.roundNumber}-${entry.roundIndex}`}
              round={entry.round}
              isLatest={entry.roundIndex === turn.rounds.length - 1}
              roundIndex={entry.roundIndex}
              isLastTurn={isLastTurn}
              allowRetry
              allowRoundRetry={!isParallelMode}
              allowStreamRetry
              turnMode={turnMode}
              totalRounds={turn.rounds.length}
              branchesConversation={branchesConversation}
            />
          ))
        )}
      </div>
    );
  };

  const searchPanel = turn.webSearchResult ? (
    <WebSearchPanel
      webSearchResult={turn.webSearchResult}
      canRetry={canRetryWebSearch}
      onRetry={retryWebSearch}
      branchesConversation={branchesConversation}
    />
  ) : null;

  const attentionPanel = (
    <AttentionPanel
      attentionStreams={attentionStreams}
      canRetryFailures={canRetryFailures}
      retryAllFailed={retryAllFailed}
      retryStream={retryStream}
      totalRounds={turn.rounds?.length || 0}
      turnMode={turnMode}
      branchesConversation={branchesConversation}
    />
  );
  const visibleRebuttalEntries = rebuttalDisplayMode === 'round'
    ? rebuttalRoundEntries.slice(activeRebuttalRoundIndex, activeRebuttalRoundIndex + 1)
    : rebuttalRoundEntries;

  const userPromptPanel = (
    <div className="user-message">
      <div className="user-message-body">
        <div className="user-message-header">
          <div className="user-message-actions">
            <CopyButton text={turn.userPrompt} />
            {isLastTurn && !debateInProgress && (
              <>
                <button
                  className="user-action-btn"
                  onClick={editLastTurn}
                  title={branchesConversation ? 'Edit this message in a new branch' : 'Edit this message'}
                >
                  <Pencil size={14} />
                </button>
                {hasRounds && (
                  <button
                    className="user-action-btn"
                    onClick={(event) => retryLastTurn({ forceRefresh: event.shiftKey })}
                    title={branchesConversation
                      ? 'Rerun this entire turn in a new branch. Hold Shift to bypass the cache.'
                      : 'Rerun this entire turn. Hold Shift to bypass the cache.'}
                  >
                    <RotateCcw size={14} />
                  </button>
                )}
              </>
            )}
          </div>
          <span className="user-label">You</span>
          {turn.timestamp && (
            <span className="user-timestamp">{formatFullTimestamp(turn.timestamp)}</span>
          )}
        </div>
        <div className="user-text markdown-content">
          <MarkdownRenderer>{turn.userPrompt}</MarkdownRenderer>
        </div>
        {turn.attachments && turn.attachments.length > 0 && (
          <div className="user-attachments-grid">
            {turn.attachments.map((attachment, index) => (
              <AttachmentCard
                key={attachment.uploadId || attachment.storageId || `${attachment.name}-${index}`}
                attachment={attachment}
                routing={turnAttachmentRouting[index]}
                onPreview={() => setViewerAttachment(attachment)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="user-avatar">
        <User size={14} />
      </div>
    </div>
  );

  return (
    <div className={`debate-turn ${highlighted ? 'search-target' : ''}`.trim()}>
      {userPromptPanel}

      {viewerAttachment && (
        <Suspense fallback={null}>
          <AttachmentViewer attachment={viewerAttachment} onClose={() => setViewerAttachment(null)} />
        </Suspense>
      )}

      {showTabbedStages ? (
        <>
          <div className="turn-explorer glass-panel">
            <div className="turn-explorer-header">
              <button
                type="button"
                className="turn-explorer-toggle"
                onClick={() => setIsTurnExplorerOpen((open) => !open)}
                aria-expanded={isTurnExplorerOpen}
                aria-label={`Turn Breakdown. ${isTurnExplorerOpen ? 'Collapse' : 'Expand'} the stage explorer.`}
                title={`Turn Breakdown groups this turn into stages. Click to ${isTurnExplorerOpen ? 'collapse' : 'expand'} the stage explorer.`}
              >
                <div className="turn-explorer-heading">
                  <div className="turn-explorer-title-row">
                    <span className="turn-explorer-title">Turn Breakdown</span>
                  </div>
                </div>
                <div className="turn-explorer-summary">
                  {attentionStreams.length > 0 && (
                    <span className="turn-explorer-badge attention">
                      {attentionStreams.length} issue{attentionStreams.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {rebuttalRoundEntries.length > 0 && (
                    <span className="turn-explorer-badge">
                      {rebuttalRoundEntries.length} rebuttal{rebuttalRoundEntries.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  <span className="turn-explorer-badge">{stageTabs.length} tab{stageTabs.length !== 1 ? 's' : ''}</span>
                  <span className="turn-explorer-chevron">
                    {isTurnExplorerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </span>
                </div>
              </button>
              <InfoTip
                className="turn-explorer-help"
                content={[
                  'Turn Breakdown groups a turn into stages like search, initial responses, and rebuttal rounds.',
                  `Use it to ${isTurnExplorerOpen ? 'collapse' : 'expand'} the stage explorer and inspect one stage at a time.`,
                ]}
                label="Turn breakdown help"
              />
            </div>

            {isTurnExplorerOpen && (
              <>
                <div className="turn-stage-toolbar">
                  <DebateProgressBar rounds={turn.rounds} debateMetadata={turn.debateMetadata} compact />
                  <StageTabs tabs={stageTabs} activeTab={activeStageTab} onChange={setActiveStageTab} />
                  {activeStageTab !== 'web-search' && (
                    <div className="turn-stage-control-group">
                      <div className="debate-view-toggle">
                        <button
                          className={`view-toggle-btn ${viewMode === 'cards' ? 'active' : ''}`}
                          onClick={() => setViewMode('cards')}
                          aria-label="Show each round as stacked cards for easier per-round inspection"
                          title="Show each round as stacked cards for easier per-round inspection."
                        >
                          <LayoutGrid size={14} />
                          <span>Cards</span>
                        </button>
                        <button
                          className={`view-toggle-btn ${viewMode === 'thread' ? 'active' : ''}`}
                          onClick={() => setViewMode('thread')}
                          aria-label="Show the full debate as one continuous conversation thread"
                          title="Show the full debate as one continuous conversation thread."
                        >
                          <MessageSquare size={14} />
                          <span>Thread</span>
                        </button>
                      </div>
                      <InfoTip
                        content={[
                          'Cards groups each round into stacked sections for easier inspection.',
                          'Thread shows the full debate as one continuous conversation.',
                        ]}
                        label="Round view help"
                      />
                    </div>
                  )}
                </div>

                <div className="turn-stage-body">
                  {activeStageTab !== 'web-search' && activeStageTab !== 'rebuttal-rounds' && attentionStreams.length > 0 && attentionPanel}

                  {activeStageTab === 'web-search' && searchPanel}

                  {activeStageTab === 'initial-responses' && (
                    renderRoundEntries(initialRoundEntries, 'Initial responses will appear here.')
                  )}

                  {activeStageTab === 'rebuttal-rounds' && (
                    <>
                      {rebuttalRoundEntries.length > 1 && (
                        <div className="turn-stage-subheader">
                          <div className="turn-stage-control-group">
                            <div className="debate-view-toggle" role="tablist" aria-label="Rebuttal display mode">
                              <button
                                type="button"
                                role="tab"
                                aria-selected={rebuttalDisplayMode === 'sequential'}
                                className={`view-toggle-btn ${rebuttalDisplayMode === 'sequential' ? 'active' : ''}`}
                                onClick={() => setRebuttalDisplayMode('sequential')}
                                aria-label="Show every rebuttal round in one long list"
                                title="Show every rebuttal round in one long list."
                              >
                                <span>Sequential</span>
                              </button>
                              <button
                                type="button"
                                role="tab"
                                aria-selected={rebuttalDisplayMode === 'round'}
                                className={`view-toggle-btn ${rebuttalDisplayMode === 'round' ? 'active' : ''}`}
                                onClick={() => setRebuttalDisplayMode('round')}
                                aria-label="Show one rebuttal round at a time and switch between them manually"
                                title="Show one rebuttal round at a time and switch between them manually."
                              >
                                <span>Round by round</span>
                              </button>
                            </div>
                            <InfoTip
                              content={[
                                'Sequential shows every rebuttal round in one long list.',
                                'Round by round shows one rebuttal round at a time and lets you switch manually.',
                              ]}
                              label="Rebuttal display mode help"
                            />
                          </div>

                          {rebuttalDisplayMode === 'round' && (
                            <div className="turn-round-nav" role="tablist" aria-label="Rebuttal round picker">
                              {rebuttalRoundEntries.map((entry, index) => {
                                const roundLabel = `Round ${entry.round.roundNumber || entry.roundIndex + 1}`;
                                return (
                                  <button
                                    key={`rebuttal-round-${entry.round.roundNumber || entry.roundIndex}`}
                                    type="button"
                                    role="tab"
                                    aria-selected={activeRebuttalRoundIndex === index}
                                    aria-label={roundLabel}
                                    className={`turn-stage-tab ${activeRebuttalRoundIndex === index ? 'active' : ''}`}
                                    onClick={() => setActiveRebuttalRoundIndex(index)}
                                    title={`Show ${roundLabel}`}
                                  >
                                    <span>{roundLabel}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {attentionStreams.length > 0 && attentionPanel}

                      {renderRoundEntries(visibleRebuttalEntries, 'No rebuttal rounds yet.')}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {!isParallelMode && turn.synthesis && (
            <SynthesisView
              synthesis={turn.synthesis}
              debateMetadata={turn.debateMetadata}
              isLastTurn={isLastTurn}
              rounds={turn.rounds}
              showInternals={false}
              branchesConversation={branchesConversation}
            />
          )}

          {!isParallelMode && turn.synthesis?.status === 'complete' && turnCostLabel && (
            <div className="turn-cost-summary">
              Turn cost:{' '}
              <span
                className={`turn-cost-value ${turnCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                title={getCostQualityDescription(turnCostMeta.quality)}
              >
                {turnCostLabel}
              </span>
            </div>
          )}
        </>
      ) : (
        <>
          {searchPanel}

          {attentionPanel}

          {isDirectMode && hasRounds && isEnsembleTurn && (
            <>
              <EnsembleResultPanel ensembleResult={turn.ensembleResult} />

              <RoundSection
                round={turn.rounds[0]}
                isLatest
                roundIndex={0}
                isLastTurn={isLastTurn}
                turnMode={turnMode}
                totalRounds={turn.rounds.length}
                branchesConversation={branchesConversation}
              />

              {turn.synthesis && turn.synthesis.status !== 'pending' && (
                <SynthesisView
                  synthesis={turn.synthesis}
                  debateMetadata={turn.debateMetadata}
                  isLastTurn={isLastTurn}
                  rounds={turn.rounds}
                  ensembleResult={turn.ensembleResult}
                  branchesConversation={branchesConversation}
                />
              )}

              {turn.synthesis?.status === 'complete' && turnCostLabel && (
                <div className="turn-cost-summary">
                  Turn cost:{' '}
                  <span
                    className={`turn-cost-value ${turnCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                    title={getCostQualityDescription(turnCostMeta.quality)}
                  >
                    {turnCostLabel}
                  </span>
                </div>
              )}
            </>
          )}

          {isDirectMode && hasRounds && !isEnsembleTurn && (
            <>
              <div className="direct-response">
                {turn.rounds[0]?.streams[0] && (
                  <ModelCard
                    stream={turn.rounds[0].streams[0]}
                    roundIndex={0}
                    streamIndex={0}
                    isLastTurn={isLastTurn}
                    allowRetry
                    turnMode={turnMode}
                    totalRounds={turn.rounds.length}
                    roundNumber={1}
                    roundModels={(turn.rounds[0].streams || []).map((item) => item.model)}
                    branchesConversation={branchesConversation}
                  />
                )}
              </div>
              {turn.rounds[0]?.streams[0]?.status === 'complete' && turnCostLabel && (
                <div className="turn-cost-summary">
                  Turn cost:{' '}
                  <span
                    className={`turn-cost-value ${turnCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                    title={getCostQualityDescription(turnCostMeta.quality)}
                  >
                    {turnCostLabel}
                  </span>
                </div>
              )}
            </>
          )}

          {!isDirectMode && !isParallelMode && turn.synthesis && turn.synthesis.status !== 'pending' && (
            <SynthesisView
              synthesis={turn.synthesis}
              debateMetadata={turn.debateMetadata}
              isLastTurn={isLastTurn}
              rounds={turn.rounds}
              branchesConversation={branchesConversation}
            />
          )}

          {!isDirectMode && !isParallelMode && turn.synthesis?.status === 'complete' && turnCostLabel && (
            <div className="turn-cost-summary">
              Turn cost:{' '}
              <span
                className={`turn-cost-value ${turnCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                title={getCostQualityDescription(turnCostMeta.quality)}
              >
                {turnCostLabel}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default memo(DebateView);
