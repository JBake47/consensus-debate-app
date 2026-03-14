import { memo, useState, useRef, useEffect, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
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

const THREAD_VIRTUALIZATION_THRESHOLD = 18;

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
              onClick={(event) => retryStream(roundIndex, streamIndex, { forceRefresh: event.shiftKey })}
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

function RoundDivider({ label }) {
  return (
    <div className="thread-round-divider">
      <span className="thread-round-label">{label}</span>
    </div>
  );
}

function ThreadConvergencePanel({ convergenceCheck, roundNumber }) {
  return (
    <div className="thread-convergence-panel">
      <ConvergencePanel convergenceCheck={convergenceCheck} roundNumber={roundNumber} />
    </div>
  );
}

function renderThreadItem(item, sharedProps) {
  if (item.type === 'divider') {
    return <RoundDivider label={item.label} />;
  }
  if (item.type === 'convergence') {
    return (
      <ThreadConvergencePanel
        convergenceCheck={item.convergenceCheck}
        roundNumber={item.roundNumber}
      />
    );
  }

  return (
    <ThreadMessage
      stream={item.stream}
      roundNumber={item.roundNumber}
      roundIndex={item.roundIndex}
      streamIndex={item.streamIndex}
      roundModels={item.roundModels}
      {...sharedProps}
    />
  );
}

function DebateThread({ rounds, isLastTurn = false, allowRetry = true, turnMode = 'debate', totalRounds = 1 }) {
  const threadItems = useMemo(() => {
    if (!Array.isArray(rounds) || rounds.length === 0) return [];

    return rounds.flatMap((round, roundIndex) => {
      const items = [{
        type: 'divider',
        key: `divider-${round.roundNumber}-${roundIndex}`,
        label: round.label,
      }];

      (round.streams || []).forEach((stream, streamIndex) => {
        items.push({
          type: 'message',
          key: `${round.roundNumber}-${stream.model}-${streamIndex}`,
          stream,
          roundNumber: round.roundNumber,
          roundIndex,
          streamIndex,
          roundModels: (round.streams || []).map((item) => item.model),
        });
      });

      if (round.convergenceCheck) {
        items.push({
          type: 'convergence',
          key: `convergence-${round.roundNumber}-${roundIndex}`,
          convergenceCheck: round.convergenceCheck,
          roundNumber: round.roundNumber,
        });
      }

      return items;
    });
  }, [rounds]);

  if (threadItems.length === 0) return null;

  const sharedProps = {
    isLastTurn,
    allowRetry,
    turnMode,
    totalRounds,
  };

  if (threadItems.length <= THREAD_VIRTUALIZATION_THRESHOLD) {
    return (
      <div className="debate-thread">
        {threadItems.map((item) => (
          <div key={item.key} className="thread-virtuoso-item">
            {renderThreadItem(item, sharedProps)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="debate-thread debate-thread-virtualized">
      <div className="thread-virtualized-note">
        Large debate thread virtualized for smoother scrolling.
      </div>
      <Virtuoso
        className="debate-thread-virtuoso"
        style={{ height: 'min(70vh, 900px)' }}
        data={threadItems}
        increaseViewportBy={{ top: 400, bottom: 700 }}
        computeItemKey={(index, item) => item.key || index}
        itemContent={(index, item) => (
          <div className="thread-virtuoso-item">
            {renderThreadItem(item, sharedProps)}
          </div>
        )}
      />
    </div>
  );
}

export default memo(DebateThread);
