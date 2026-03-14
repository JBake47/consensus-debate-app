import { memo, useMemo, useRef, useState } from 'react';
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
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry?.({ forceRefresh: e.shiftKey });
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
  const [viewMode, setViewMode] = useState('cards'); // 'cards' or 'thread'
  const [viewerAttachment, setViewerAttachment] = useState(null);
  const hasRounds = turn.rounds && turn.rounds.length > 0;
  const isDirectMode = turn.mode === 'direct';
  const isParallelMode = turn.mode === 'parallel';
  // Ensemble turns have multiple streams in their round or an ensembleResult
  const isEnsembleTurn = isDirectMode && (
    turn.ensembleResult != null ||
    (hasRounds && turn.rounds[0]?.streams?.length > 1)
  );
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
  const shouldVirtualizeRounds = (
    streamVirtualizationEnabled
    && viewMode === 'cards'
    && Array.isArray(turn.rounds)
    && turn.rounds.length > Math.max(6, keepLatestRounds + 1)
  );

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

  const canRetryFailures = isLastTurn && !debateInProgress;
  const canRetryWebSearch = isLastTurn && !debateInProgress;

  return (
    <div className="debate-turn">
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
                      onClick={(e) => retryLastTurn({ forceRefresh: e.shiftKey })}
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
              {turn.attachments.map((att, i) => (
                <AttachmentCard
                  key={att.uploadId || att.storageId || `${att.name}-${i}`}
                  attachment={att}
                  routing={turnAttachmentRouting[i]}
                  onPreview={() => setViewerAttachment(att)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="user-avatar">
          <User size={14} />
        </div>
      </div>

      {viewerAttachment && (
        <AttachmentViewer attachment={viewerAttachment} onClose={() => setViewerAttachment(null)} />
      )}

      {turn.webSearchResult && (
        <WebSearchPanel
          webSearchResult={turn.webSearchResult}
          canRetry={canRetryWebSearch}
          onRetry={retryWebSearch}
        />
      )}

      {attentionStreams.length > 0 && (
        <div className="turn-error-panel glass-panel">
          <div className="turn-error-header">
            <div className="turn-error-title">Attention needed</div>
            {canRetryFailures && (
              <button
                className="turn-error-retry-all-btn"
                onClick={(e) => retryAllFailed({ forceRefresh: e.shiftKey })}
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
            {attentionStreams.map((failure, idx) => {
              const diagnostics = getErrorDiagnostics(failure.error);
              const retryScope = getRetryScopeDescription({
                scope: 'stream',
                mode: turn.mode || 'debate',
                roundNumber: failure.roundNumber,
                totalRounds: turn.rounds.length,
                modelName: getModelDisplayName(failure.model),
              });
              return (
                <div key={`${failure.model}-${idx}`} className="turn-error-item">
                  <div className="turn-error-row">
                    <span className="turn-error-model">{getModelDisplayName(failure.model)}</span>
                    <div className="turn-error-actions">
                      {canRetryFailures && (
                        <button
                          className="turn-error-retry-btn"
                          onClick={(e) => retryStream(
                            failure.roundIndex,
                            failure.streamIndex,
                            { forceRefresh: e.shiftKey },
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
                          totalRounds={turn.rounds.length}
                          turnMode={turn.mode || 'debate'}
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
      )}

      {isDirectMode && hasRounds && isEnsembleTurn && (
        <>
          <EnsembleResultPanel ensembleResult={turn.ensembleResult} />

          <RoundSection
            round={turn.rounds[0]}
            isLatest
            roundIndex={0}
            isLastTurn={isLastTurn}
            turnMode={turn.mode || 'direct'}
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
                turnMode={turn.mode || 'direct'}
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

      {!isDirectMode && hasRounds && (
        <>
          <div className="debate-controls">
            <DebateProgressBar rounds={turn.rounds} debateMetadata={turn.debateMetadata} />
            {turn.rounds.length > 0 && (
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

          {viewMode === 'cards' ? (
            <div className="debate-rounds">
              {shouldVirtualizeRounds && (
                <div className="debate-virtualized-banner">
                  <span>
                    Large round list virtualized automatically.
                    {attentionRoundIndices.length > 0 && ` ${attentionRoundIndices.length} round${attentionRoundIndices.length !== 1 ? 's' : ''} currently need attention.`}
                  </span>
                </div>
              )}
              {shouldVirtualizeRounds ? (
                <Virtuoso
                  className="debate-rounds-virtuoso"
                  style={{ height: 'min(72vh, 960px)' }}
                  data={turn.rounds}
                  increaseViewportBy={{ top: 500, bottom: 700 }}
                  computeItemKey={(index, round) => `${round.roundNumber}-${index}`}
                  itemContent={(index, round) => (
                    <div className="debate-rounds-item">
                      <RoundSection
                        round={round}
                        isLatest={index === turn.rounds.length - 1}
                        roundIndex={index}
                        isLastTurn={isLastTurn}
                        allowRetry
                        allowRoundRetry={!isParallelMode}
                        allowStreamRetry
                        turnMode={turn.mode || 'debate'}
                        totalRounds={turn.rounds.length}
                      />
                    </div>
                  )}
                />
              ) : (
                turn.rounds.map((round, index) => (
                  <RoundSection
                    key={round.roundNumber}
                    round={round}
                    isLatest={index === turn.rounds.length - 1}
                    roundIndex={index}
                    isLastTurn={isLastTurn}
                    allowRetry
                    allowRoundRetry={!isParallelMode}
                    allowStreamRetry
                    turnMode={turn.mode || 'debate'}
                    totalRounds={turn.rounds.length}
                  />
                ))
              )}
            </div>
          ) : (
            <DebateThread
              rounds={turn.rounds}
              isLastTurn={isLastTurn}
              allowRetry
              turnMode={turn.mode || 'debate'}
              totalRounds={turn.rounds.length}
            />
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
    </div>
  );
}

export default memo(DebateView);
