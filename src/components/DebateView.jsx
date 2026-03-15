import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
import AttachmentViewer from './AttachmentViewer';
import ResponseViewerModal from './ResponseViewerModal';
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

function WebSearchPanel({ webSearchResult, canRetry = false, onRetry = null }) {
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
      <div className="web-search-header" onClick={() => status === 'complete' && setCollapsed(!collapsed)}>
        <div className="web-search-header-left">
          <Globe size={14} className="web-search-icon" />
          <span className="web-search-label">Web Search</span>
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
                  title={`${getRetryScopeDescription({ scope: 'web_search' })} Shift bypasses cache.`}
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
    <ResponseViewerModal open={viewerOpen} onClose={() => setViewerOpen(false)} title="Web Search">
      {panel}
    </ResponseViewerModal>
  ) : panel;
}

function AttentionPanel({
  attentionStreams,
  canRetryFailures,
  retryAllFailed,
  retryStream,
  totalRounds,
  turnMode,
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
            title="Repair the earliest warning or failed round and rebuild forward. Shift bypasses cache."
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
                      title={`Choose a replacement model for ${getModelDisplayName(failure.model)}. Shift starts with cache bypass enabled.`}
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

function StageTabs({ tabs, activeTab, onChange }) {
  if (tabs.length === 0) return null;

  return (
    <div className="turn-stage-tabs" role="tablist" aria-label="Turn stages">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={`turn-stage-tab ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
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

function DebateView({ turn, isLastTurn }) {
  const {
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
  const { debateInProgress } = useDebateConversations();
  const [viewMode, setViewMode] = useState('cards');
  const [activeStageTab, setActiveStageTab] = useState(() => (
    Array.isArray(turn.rounds) && turn.rounds.length > 0
      ? 'initial-responses'
      : (turn.webSearchResult ? 'web-search' : null)
  ));
  const [isTurnExplorerOpen, setIsTurnExplorerOpen] = useState(false);
  const [rebuttalDisplayMode, setRebuttalDisplayMode] = useState('sequential');
  const [activeRebuttalRoundIndex, setActiveRebuttalRoundIndex] = useState(0);
  const [viewerAttachment, setViewerAttachment] = useState(null);
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

  const canRetryFailures = isLastTurn && !debateInProgress;
  const canRetryWebSearch = isLastTurn && !debateInProgress;
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
      tabs.push({ id: 'web-search', label: 'Web Search' });
    }
    if (initialRoundEntries.length > 0) {
      tabs.push({ id: 'initial-responses', label: 'Initial Responses' });
    }
    if (rebuttalRoundEntries.length > 0) {
      tabs.push({
        id: 'rebuttal-rounds',
        label: 'Rebuttal Rounds',
        count: rebuttalRoundEntries.length,
      });
    }
    return tabs;
  }, [showTabbedStages, turn.webSearchResult, initialRoundEntries.length, rebuttalRoundEntries.length]);

  const stageTabsKey = stageTabs.map((tab) => tab.id).join('|');

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
    if (attentionStreams.length > 0) {
      setIsTurnExplorerOpen(true);
    }
  }, [attentionStreams.length]);

  useEffect(() => {
    if (rebuttalRoundEntries.length === 0) {
      setActiveRebuttalRoundIndex(0);
      return;
    }

    setActiveRebuttalRoundIndex((current) => Math.min(current, rebuttalRoundEntries.length - 1));
  }, [rebuttalRoundEntries.length]);

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
                  title="Edit this message"
                >
                  <Pencil size={14} />
                </button>
                {hasRounds && (
                  <button
                    className="user-action-btn"
                    onClick={(event) => retryLastTurn({ forceRefresh: event.shiftKey })}
                    title="Retry this turn (Shift: bypass cache)"
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
    <div className="debate-turn">
      {userPromptPanel}

      {viewerAttachment && (
        <AttachmentViewer attachment={viewerAttachment} onClose={() => setViewerAttachment(null)} />
      )}

      {showTabbedStages ? (
        <>
          <div className="turn-explorer glass-panel">
            <button
              type="button"
              className="turn-explorer-toggle"
              onClick={() => setIsTurnExplorerOpen((open) => !open)}
              aria-expanded={isTurnExplorerOpen}
            >
              <div className="turn-explorer-heading">
                <span className="turn-explorer-title">Turn Breakdown</span>
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

            {isTurnExplorerOpen && (
              <>
                <div className="turn-explorer-header">
                  <div className="turn-explorer-header-controls">
                    <DebateProgressBar rounds={turn.rounds} debateMetadata={turn.debateMetadata} />
                    {activeStageTab !== 'web-search' && (
                      <div className="debate-view-toggle">
                        <button
                          className={`view-toggle-btn ${viewMode === 'cards' ? 'active' : ''}`}
                          onClick={() => setViewMode('cards')}
                          title="Card view"
                        >
                          <LayoutGrid size={14} />
                          <span>Cards</span>
                        </button>
                        <button
                          className={`view-toggle-btn ${viewMode === 'thread' ? 'active' : ''}`}
                          onClick={() => setViewMode('thread')}
                          title="Debate thread view"
                        >
                          <MessageSquare size={14} />
                          <span>Thread</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <StageTabs tabs={stageTabs} activeTab={activeStageTab} onChange={setActiveStageTab} />

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
                          <div className="debate-view-toggle" role="tablist" aria-label="Rebuttal display mode">
                            <button
                              type="button"
                              role="tab"
                              aria-selected={rebuttalDisplayMode === 'sequential'}
                              className={`view-toggle-btn ${rebuttalDisplayMode === 'sequential' ? 'active' : ''}`}
                              onClick={() => setRebuttalDisplayMode('sequential')}
                              title="Show all rebuttal rounds in order"
                            >
                              <span>Sequential</span>
                            </button>
                            <button
                              type="button"
                              role="tab"
                              aria-selected={rebuttalDisplayMode === 'round'}
                              className={`view-toggle-btn ${rebuttalDisplayMode === 'round' ? 'active' : ''}`}
                              onClick={() => setRebuttalDisplayMode('round')}
                              title="Show one rebuttal round at a time"
                            >
                              <span>Round by round</span>
                            </button>
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
              />

              {turn.synthesis && turn.synthesis.status !== 'pending' && (
                <SynthesisView
                  synthesis={turn.synthesis}
                  debateMetadata={turn.debateMetadata}
                  isLastTurn={isLastTurn}
                  rounds={turn.rounds}
                  ensembleResult={turn.ensembleResult}
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
            <SynthesisView synthesis={turn.synthesis} debateMetadata={turn.debateMetadata} isLastTurn={isLastTurn} rounds={turn.rounds} />
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
