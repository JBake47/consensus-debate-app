import { memo, useEffect, useRef, useState } from 'react';
import { User, Globe, ChevronDown, ChevronUp, Loader2, AlertCircle, FileText, Image as ImageIcon, Pencil, RotateCcw, LayoutGrid, MessageSquare } from 'lucide-react';
import { useDebateActions, useDebateConversations, useDebateSettings } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import ExpandButton from './ExpandButton';
import { formatFileSize } from '../lib/formatFileSize';
import ModelCard from './ModelCard';
import ReplaceModelButton from './ReplaceModelButton';
import RoundSection from './RoundSection';
import DebateThread from './DebateThread';
import DebateProgressBar from './DebateProgressBar';
import SynthesisView from './SynthesisView';
import EnsembleResultPanel from './EnsembleResultPanel';
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
  } = useDebateSettings();
  const { debateInProgress } = useDebateConversations();
  const [viewMode, setViewMode] = useState('cards'); // 'cards' or 'thread'
  const [viewerAttachment, setViewerAttachment] = useState(null);
  const [showAllRounds, setShowAllRounds] = useState(false);
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
  const attentionRoundIndices = Array.isArray(turn.rounds)
    ? turn.rounds
      .map((round, index) => (isRoundAttentionRequired(round) ? index : null))
      .filter((value) => value != null)
    : [];

  const roundRenderPlan = (() => {
    const rounds = Array.isArray(turn.rounds) ? turn.rounds : [];
    if (
      !streamVirtualizationEnabled ||
      showAllRounds ||
      viewMode !== 'cards' ||
      rounds.length <= keepLatestRounds + 1
    ) {
      return {
        hiddenCount: 0,
        attentionHiddenCount: 0,
        items: rounds.map((round, roundIndex) => ({ round, roundIndex })),
      };
    }
    const visibleIndices = new Set([0]);
    const tailStart = Math.max(0, rounds.length - keepLatestRounds);
    for (let index = tailStart; index < rounds.length; index += 1) {
      visibleIndices.add(index);
    }
    for (const index of attentionRoundIndices) {
      visibleIndices.add(index);
    }
    const sortedIndices = Array.from(visibleIndices).sort((a, b) => a - b);
    return {
      hiddenCount: Math.max(0, rounds.length - sortedIndices.length),
      attentionHiddenCount: attentionRoundIndices.filter((index) => !visibleIndices.has(index)).length,
      items: sortedIndices.map((roundIndex) => ({ round: rounds[roundIndex], roundIndex })),
    };
  })();

  const hiddenRoundCount = roundRenderPlan.hiddenCount;
  const pinnedAttentionCount = attentionRoundIndices.filter((index) =>
    !showAllRounds
    && roundRenderPlan.items.some((item) => item.roundIndex === index)
    && index !== 0
    && index < Math.max(0, turn.rounds.length - keepLatestRounds)
  ).length;

  useEffect(() => {
    setShowAllRounds(false);
  }, [turn.id, turn.timestamp, turn.rounds?.length]);

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
            <div className="user-attachments">
              {turn.attachments.map((att, i) => (
                <button
                  key={i}
                  className={`user-attachment-chip ${att.category}`}
                  onClick={() => setViewerAttachment(att)}
                  title="View attachment"
                >
                  {att.category === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}
                  <span className="user-attachment-name">{att.name}</span>
                  <span className="user-attachment-size">{formatFileSize(att.size)}</span>
                </button>
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
              {hiddenRoundCount > 0 && !showAllRounds && (
                <div className="debate-virtualized-banner">
                  <span>
                    {hiddenRoundCount} older round{hiddenRoundCount !== 1 ? 's' : ''} compacted automatically.
                    {pinnedAttentionCount > 0 && ` ${pinnedAttentionCount} kept visible because they need attention.`}
                  </span>
                  <button
                    className="debate-virtualized-btn"
                    onClick={() => setShowAllRounds(true)}
                    type="button"
                  >
                    Show All Rounds
                  </button>
                </div>
              )}
              {roundRenderPlan.items.map(({ round, roundIndex: i }) => (
                <RoundSection
                  key={round.roundNumber}
                  round={round}
                  isLatest={i === turn.rounds.length - 1}
                  roundIndex={i}
                  isLastTurn={isLastTurn}
                  allowRetry
                  allowRoundRetry={!isParallelMode}
                  allowStreamRetry
                  turnMode={turn.mode || 'debate'}
                  totalRounds={turn.rounds.length}
                />
              ))}
              {showAllRounds && hiddenRoundCount > 0 && (
                <div className="debate-virtualized-banner">
                  <span>All rounds are visible.</span>
                  <button
                    className="debate-virtualized-btn"
                    onClick={() => setShowAllRounds(false)}
                    type="button"
                  >
                    Collapse Older Rounds
                  </button>
                </div>
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
