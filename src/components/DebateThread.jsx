import { memo, useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp, Loader2, AlertCircle, Brain, Globe, RotateCcw } from 'lucide-react';
import { useDebateActions, useDebateConversations } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import ConvergencePanel from './ConvergencePanel';
import ExpandButton from './ExpandButton';
import ReplaceModelButton from './ReplaceModelButton';
import ResponseViewerModal from './ResponseViewerModal';
import { getModelDisplayName, getProviderName, getModelColor } from '../lib/openrouter';
import { recordPreviewPointerDown, shouldExpandPreviewFromClick } from '../lib/previewExpand';
import { getRetryScopeDescription, getStreamDisplayState } from '../lib/retryState';
import {
  formatTokenCount,
  formatDuration,
  formatCostWithQuality,
  getCostQualityDescription,
  getUsageCostMeta,
} from '../lib/formatTokens';
import './DebateThread.css';

function ThreadMessage({ stream, roundNumber, roundIndex, streamIndex, isLastTurn, allowRetry, turnMode, totalRounds, roundModels = [] }) {
  const { retryStream } = useDebateActions();
  const { debateInProgress } = useDebateConversations();
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const contentRef = useRef(null);
  const previewPointerRef = useRef(null);
  const { model, content, status, error, usage, durationMs, reasoning, searchEvidence, routeInfo, cacheHit } = stream;
  const canRetry = allowRetry && isLastTurn && !debateInProgress && status !== 'streaming';
  const displayState = getStreamDisplayState(stream);
  const canExpandViewer = !viewerOpen && Boolean(content) && status !== 'pending';

  const color = getModelColor(model);
  const displayName = getModelDisplayName(model);
  const provider = getProviderName(model);
  const canReplace = canRetry
    && (displayState.tone === 'warning' || displayState.tone === 'error' || Boolean(error));
  const searchEvidenceClass = searchEvidence?.verified
    ? 'verified'
    : searchEvidence?.strictBlocked
      ? 'blocked'
      : 'unverified';
  const searchSummary = searchEvidence
    ? `Search ${searchEvidence.searchUsed ? 'yes' : 'no'} | ${searchEvidence.sourceCount || 0} src`
    : null;
  const searchTitle = searchEvidence
    ? [
      searchEvidence.primaryIssue ? `Issue: ${searchEvidence.primaryIssue}` : null,
      searchEvidence.fallbackApplied && searchEvidence.fallbackReason
        ? `Fallback: ${searchEvidence.fallbackReason}`
        : null,
    ].filter(Boolean).join('\n')
    : '';
  const routeSummary = routeInfo?.routed
    ? `Routed to ${getModelDisplayName(routeInfo.fallbackModel || model)}`
    : routeInfo?.reason
      ? 'Route warning'
      : null;
  const routeTitle = routeInfo?.reason || '';
  const routeClass = routeInfo?.routed ? 'routed' : 'blocked';
  const costMeta = getUsageCostMeta(usage, model);
  const costLabel = formatCostWithQuality(costMeta);
  const retryScopeTitle = getRetryScopeDescription({
    scope: 'stream',
    mode: turnMode,
    roundNumber,
    totalRounds,
    modelName: displayName,
  });
  const showRetryScope = canRetry && (displayState.tone === 'warning' || displayState.tone === 'error');

  useEffect(() => {
    if (status === 'streaming' && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, status]);

  const handlePreviewClick = (event) => {
    if (!canExpandViewer || !shouldExpandPreviewFromClick(event, previewPointerRef)) {
      return;
    }

    setViewerOpen(true);
  };

  const message = (
    <div
      className={`thread-message ${status} ${viewerOpen ? 'fullscreen-panel glass-panel' : ''}`}
      style={{ '--thread-accent': color }}
    >
      <div className="thread-message-avatar">
        <div className="thread-avatar-dot" />
      </div>
      <div className="thread-message-body">
        <div className="thread-message-header">
          <span className="thread-message-provider">{provider}</span>
          <span className="thread-message-model">{displayName}</span>
          <span className="thread-message-round">R{roundNumber}</span>
          {status === 'streaming' && <Loader2 size={12} className="spinning" />}
          {canExpandViewer && (
            <ExpandButton onClick={() => setViewerOpen(true)} />
          )}
          {status === 'complete' && content && (
            <CopyButton text={content} />
          )}
          {canRetry && (
            <button
              className="thread-message-retry"
              onClick={(e) => retryStream(roundIndex, streamIndex, { forceRefresh: e.shiftKey })}
              title={`${retryScopeTitle} Shift bypasses cache.`}
            >
              <RotateCcw size={12} />
            </button>
          )}
          {canReplace && (
            <ReplaceModelButton
              className="thread-message-replace"
              currentModel={model}
              roundModels={roundModels}
              roundIndex={roundIndex}
              streamIndex={streamIndex}
              roundNumber={roundNumber}
              totalRounds={totalRounds}
              turnMode={turnMode}
              title={`Choose a replacement model for ${displayName}. Shift starts with cache bypass enabled.`}
            >
              Replace
            </ReplaceModelButton>
          )}
          {status === 'complete' && (usage || durationMs) && (
            <span className="thread-message-stats">
              {costLabel && (
                <>
                  <span
                    className={`thread-message-cost ${costMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                    title={getCostQualityDescription(costMeta.quality)}
                  >
                    {costLabel}
                  </span>
                  {' | '}
                </>
              )}
              {usage?.totalTokens != null && <>{formatTokenCount(usage.totalTokens)} tok</>}
              {durationMs != null && <> | {formatDuration(durationMs)}</>}
            </span>
          )}
          {searchEvidence && (
            <span className={`thread-search-pill ${searchEvidenceClass}`} title={searchTitle}>
              <Globe size={11} />
              <span>{searchSummary}</span>
            </span>
          )}
          {routeSummary && (
            <span className={`thread-route-pill ${routeClass}`} title={routeTitle}>
              <span>{routeSummary}</span>
            </span>
          )}
          {cacheHit && (
            <span className="thread-cache-pill" title="Served from local response cache">
              Cache hit
            </span>
          )}
          <span className={`thread-message-status ${displayState.tone}`}>{displayState.label}</span>
        </div>

        {searchEvidence?.fallbackApplied && searchEvidence.fallbackReason && (
          <div className={`thread-search-meta ${searchEvidenceClass}`}>
            Fallback: {searchEvidence.fallbackReason}
          </div>
        )}

        {routeInfo?.reason && (
          <div className={`thread-route-meta ${routeClass}`}>
            {routeInfo.reason}
          </div>
        )}

        {showRetryScope && (
          <div className={`thread-message-retry-scope ${displayState.tone}`}>
            {retryScopeTitle}
          </div>
        )}

        {reasoning && (
          <div className="thread-reasoning">
            <div className="thread-reasoning-header">
              <button
                className="thread-reasoning-toggle"
                onClick={() => setReasoningOpen(!reasoningOpen)}
              >
                <Brain size={12} />
                <span>Thinking</span>
                {usage?.reasoningTokens != null && (
                  <span className="thread-reasoning-tokens">{formatTokenCount(usage.reasoningTokens)} tok</span>
                )}
                {reasoningOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {reasoningOpen && status === 'complete' && (
                <CopyButton text={reasoning} />
              )}
            </div>
        {reasoningOpen && (
              <div
                className="thread-reasoning-text markdown-content scroll-preview"
                onPointerDown={(event) => recordPreviewPointerDown(previewPointerRef, event)}
                onClick={handlePreviewClick}
              >
                <MarkdownRenderer>{reasoning}</MarkdownRenderer>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className={`thread-message-error ${displayState.tone}`}>
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {content && status !== 'pending' && (
          <div
            className="thread-message-content markdown-content scroll-preview"
            ref={contentRef}
            onPointerDown={(event) => recordPreviewPointerDown(previewPointerRef, event)}
            onClick={handlePreviewClick}
          >
            <MarkdownRenderer>{content}</MarkdownRenderer>
            {status === 'streaming' && <span className="cursor-blink" />}
          </div>
        )}

        {status === 'pending' && (
          <div className="thread-message-pending">
            <div className="pulse-dots"><span /><span /><span /></div>
          </div>
        )}
      </div>
    </div>
  );

  return viewerOpen ? (
    <ResponseViewerModal open={viewerOpen} onClose={() => setViewerOpen(false)} title={displayName}>
      {message}
    </ResponseViewerModal>
  ) : message;
}

function DebateThread({ rounds, isLastTurn = false, allowRetry = true, turnMode = 'debate', totalRounds = 1 }) {
  if (!rounds || rounds.length === 0) return null;

  return (
    <div className="debate-thread">
      {rounds.map((round, roundIndex) => (
        <div key={roundIndex} className="thread-round">
          <div className="thread-round-divider">
            <span className="thread-round-label">{round.label}</span>
          </div>
          <div className="thread-messages">
            {round.streams.map((stream, streamIndex) => (
              <ThreadMessage
                key={`${stream.model}-${streamIndex}`}
                stream={stream}
                roundNumber={round.roundNumber}
                roundIndex={roundIndex}
                streamIndex={streamIndex}
                isLastTurn={isLastTurn}
                allowRetry={allowRetry}
                turnMode={turnMode}
                totalRounds={totalRounds}
                roundModels={(round.streams || []).map((item) => item.model)}
              />
            ))}
          </div>
          {round.convergenceCheck && (
            <div className="thread-convergence-panel">
              <ConvergencePanel convergenceCheck={round.convergenceCheck} roundNumber={round.roundNumber} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default memo(DebateThread);
