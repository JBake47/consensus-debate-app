import { lazy, memo, Suspense, useRef, useEffect, useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, AlertCircle, Loader2, RotateCcw, Brain, Globe, Link2 } from 'lucide-react';
import { useDebateActions, useDebateConversations } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import ExpandButton from './ExpandButton';
import ReplaceModelButton from './ReplaceModelButton';
import { getModelDisplayName, getProviderName, getModelColor } from '../lib/openrouter';
import { extractCitations } from '../lib/citationInspector';
import { recordPreviewPointerDown, shouldExpandPreviewFromClick } from '../lib/previewExpand';
import { getRetryScopeDescription, getStreamDisplayState } from '../lib/retryState';
import {
  formatTokenCount,
  formatDuration,
  formatCostWithQuality,
  getCostQualityDescription,
  getUsageCostMeta,
} from '../lib/formatTokens';
import InfoTip from './InfoTip';
import './ModelCard.css';

const ResponseViewerModal = lazy(() => import('./ResponseViewerModal'));

function isReasoningModel(modelId) {
  const id = modelId.toLowerCase();
  return /\bo[13]\b/.test(id) || id.includes('deepseek-r1') || id.includes('qwq') || id.includes('reasoner');
}

function ModelCard({
  stream,
  roundIndex,
  streamIndex,
  isLastTurn,
  allowRetry = true,
  turnMode = 'debate',
  totalRounds = 1,
  roundNumber = null,
  roundModels = [],
  branchesConversation = false,
}) {
  const { retryStream } = useDebateActions();
  const { debateInProgress } = useDebateConversations();
  const { model, content, status, error, usage, durationMs, reasoning, searchEvidence, routeInfo, cacheHit } = stream;
  const [collapsed, setCollapsed] = useState(false);
  const reasoningModel = isReasoningModel(model);
  const [reasoningCollapsed, setReasoningCollapsed] = useState(!reasoningModel);
  const [sideBySide, setSideBySide] = useState(reasoningModel);
  const [citationExpanded, setCitationExpanded] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const contentRef = useRef(null);
  const reasoningRef = useRef(null);
  const previewPointerRef = useRef(null);
  const canRetry = allowRetry && isLastTurn && !debateInProgress && status !== 'streaming';
  const displayState = getStreamDisplayState(stream);
  const effectiveRoundNumber = Number.isFinite(Number(roundNumber))
    ? Number(roundNumber)
    : roundIndex + 1;

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
  const searchHelp = searchEvidence
    ? [
      `Search ${searchEvidence.searchUsed ? 'was used for this answer.' : 'was not used for this answer.'}`,
      `${searchEvidence.sourceCount || 0} source${Number(searchEvidence.sourceCount || 0) === 1 ? '' : 's'} collected.`,
      searchEvidence.verified
        ? 'Verified means the sources and date evidence passed strict checks.'
        : searchEvidence.strictBlocked
          ? 'Strict web-search verification blocked this answer because the evidence did not pass.'
          : 'This result did not fully pass strict verification.',
      searchEvidence.primaryIssue ? `Issue: ${searchEvidence.primaryIssue}` : null,
      searchEvidence.fallbackApplied && searchEvidence.fallbackReason
        ? `Fallback: ${searchEvidence.fallbackReason}`
        : null,
    ].filter(Boolean)
    : [];
  const routeSummary = routeInfo?.routed
    ? `Routed to ${getModelDisplayName(routeInfo.fallbackModel || model)}`
    : routeInfo?.reason
      ? 'Route warning'
      : null;
  const routeHelp = routeSummary
    ? [
      routeInfo?.routed
        ? `This response was routed to ${getModelDisplayName(routeInfo.fallbackModel || model)}.`
        : 'This response hit a routing warning.',
      routeInfo?.reason || 'The app may fall back or block delivery based on model capabilities.',
    ].filter(Boolean)
    : [];
  const routeClass = routeInfo?.routed ? 'routed' : 'blocked';
  const costMeta = getUsageCostMeta(usage, model);
  const costLabel = formatCostWithQuality(costMeta);
  const hasContentPreview = Boolean(content) && status !== 'pending';
  const hasReasoningPreview = Boolean(reasoning);
  const canExpandViewer = !viewerOpen && Boolean(content) && status !== 'pending';
  const citations = useMemo(
    () => extractCitations(content, searchEvidence?.urls || []),
    [content, searchEvidence?.urls]
  );
  const retryScopeTitle = getRetryScopeDescription({
    scope: 'stream',
    mode: turnMode,
    roundNumber: effectiveRoundNumber,
    totalRounds,
    modelName: displayName,
    branchesConversation,
  });
  const replacePickerTitle = branchesConversation
    ? `Choose a replacement model for ${displayName} in a new branch. Shift starts with cache bypass enabled.`
    : `Choose a replacement model for ${displayName}. Shift starts with cache bypass enabled.`;

  // Auto-scroll while streaming, only if user is near the bottom
  useEffect(() => {
    const el = contentRef.current;
    if (status === 'streaming' && el && !collapsed) {
      const threshold = 80;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [content, status, collapsed]);

  // Auto-scroll reasoning while streaming, only if user is near the bottom
  useEffect(() => {
    const el = reasoningRef.current;
    if (status === 'streaming' && el && !reasoningCollapsed) {
      const threshold = 80;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [reasoning, status, reasoningCollapsed]);

  // Auto-expand reasoning while streaming if reasoning is arriving but no content yet
  useEffect(() => {
    if (status === 'streaming' && reasoning && !content) {
      setReasoningCollapsed(false);
    }
  }, [status, reasoning, content]);

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

  const card = (
    <div
      className={`model-card glass-panel ${status} ${displayState.tone === 'warning' ? 'warning' : ''} ${viewerOpen ? 'fullscreen-panel' : ''}`}
      style={{ '--card-accent': color }}
    >
      <div
        className="model-card-header"
        onClick={() => setCollapsed(!collapsed)}
        title={`${displayName} response card. Click to ${collapsed ? 'expand' : 'collapse'} the response details.`}
      >
        <div className="model-card-info">
          <div className="model-card-accent-dot" />
          <div className="model-card-names">
            <span className="model-card-provider">{provider}</span>
            <span className="model-card-name">{displayName}</span>
          </div>
        </div>
          <div className="model-card-status-area">
          {canExpandViewer && (
            <ExpandButton onClick={openViewer} />
          )}
          {status === 'complete' && content && (
            <CopyButton text={content} />
          )}
          {canRetry && (
            <button
              className="model-card-retry"
              onClick={(e) => {
                e.stopPropagation();
                retryStream(roundIndex, streamIndex, { forceRefresh: e.shiftKey });
              }}
              title={`${retryScopeTitle} Shift bypasses cache.`}
            >
              <RotateCcw size={13} />
            </button>
          )}
          {canReplace && (
            <ReplaceModelButton
              className="model-card-replace"
              currentModel={model}
              roundModels={roundModels}
              roundIndex={roundIndex}
              streamIndex={streamIndex}
              roundNumber={effectiveRoundNumber}
              totalRounds={totalRounds}
              turnMode={turnMode}
              branchesConversation={branchesConversation}
              title={replacePickerTitle}
            >
              Replace
            </ReplaceModelButton>
          )}
          {status === 'complete' && (usage || durationMs) && (
            <span className="model-card-stats">
              {costLabel && (
                <>
                  <span
                    className={`model-card-cost ${costMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                    title={getCostQualityDescription(costMeta.quality)}
                  >
                    {costLabel}
                  </span>
                  {' | '}
                </>
              )}
              {usage?.totalTokens != null && <>{formatTokenCount(usage.totalTokens)} tokens</>}
              {usage?.totalTokens != null && durationMs != null && ' | '}
              {durationMs != null && formatDuration(durationMs)}
            </span>
          )}
          {searchEvidence && (
            <span className="model-card-badge-with-help">
              <span
                className={`model-card-search-pill ${searchEvidenceClass}`}
                title={searchHelp.join(' ') || 'Search evidence summary for this answer. Verified means sources and date evidence passed strict checks.'}
              >
                <Globe size={11} />
                <span>{searchSummary}</span>
              </span>
              <InfoTip
                content={searchHelp}
                label={`${displayName} search evidence help`}
              />
            </span>
          )}
          {routeSummary && (
            <span className="model-card-badge-with-help">
              <span
                className={`model-card-route-pill ${routeClass}`}
                title={routeHelp.join(' ') || 'Routing note for this response. The app may fall back or block delivery based on model capabilities.'}
              >
                <span>{routeSummary}</span>
              </span>
              <InfoTip
                content={routeHelp}
                label={`${displayName} routing help`}
              />
            </span>
          )}
          {cacheHit && (
            <span className="model-card-badge-with-help">
              <span
                className="model-card-cache-pill"
                title="Served from the local response cache instead of making a fresh provider call. Retry with Shift to bypass cache."
              >
                Cache hit
              </span>
              <InfoTip
                content={[
                  'This response came from the local cache instead of a fresh provider call.',
                  'Retry with Shift if you want to bypass the cache and force a new request.',
                ]}
                label={`${displayName} cache help`}
              />
            </span>
          )}
          <span className={`model-card-status ${displayState.tone}`}>
            {status === 'streaming' && <Loader2 size={12} className="spinning" />}
            {(displayState.tone === 'error' || displayState.tone === 'warning') && status !== 'streaming' && <AlertCircle size={12} />}
            {displayState.label}
          </span>
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </div>
      </div>

      {!collapsed && (
        <>
          {searchEvidence && (
            <div className={`model-card-search-meta ${searchEvidenceClass}`}>
              <span>{searchSummary}</span>
              {searchEvidence.fallbackApplied && searchEvidence.fallbackReason && (
                <span>Fallback: {searchEvidence.fallbackReason}</span>
              )}
              {!searchEvidence.verified && searchEvidence.primaryIssue && (
                <span>{searchEvidence.primaryIssue}</span>
              )}
            </div>
          )}
          {routeInfo?.reason && (
            <div className={`model-card-route-meta ${routeClass}`}>
              {routeInfo.reason}
            </div>
          )}
          {(error || displayState.tone === 'warning' || displayState.tone === 'error') && (
            <div className={`model-card-retry-scope ${displayState.tone}`}>
              {retryScopeTitle}
            </div>
          )}
          {citations.length > 0 && (
            <div className="model-card-citations">
              <button
                className="model-card-citations-toggle"
                onClick={() => setCitationExpanded((open) => !open)}
                type="button"
                title={`${citationExpanded ? 'Hide' : 'Show'} the citations extracted from this response.`}
              >
                <Link2 size={12} />
                <span>Citations ({citations.length})</span>
                {citationExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {citationExpanded && (
                <div className="model-card-citations-list">
                  {citations.map((citation) => (
                    <a
                      key={citation.url}
                      href={citation.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="model-card-citation-link"
                    >
                      <span>{citation.label || citation.domain || citation.url}</span>
                      {citation.domain && <span className="model-card-citation-domain">{citation.domain}</span>}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          {reasoning && sideBySide && content ? (
            <div className="model-card-side-by-side">
              <div className="model-card-reasoning side-by-side">
                <div
                  className="model-card-reasoning-header"
                  onClick={() => setReasoningCollapsed(!reasoningCollapsed)}
                  title={`Show or hide the model's reasoning trace${usage?.reasoningTokens != null ? ` (${formatTokenCount(usage.reasoningTokens)} reasoning tokens).` : '.'}`}
                >
                  <div className="model-card-reasoning-label">
                    <Brain size={13} />
                    <span>Thinking</span>
                    {usage?.reasoningTokens != null && (
                      <span className="model-card-reasoning-tokens">
                        {formatTokenCount(usage.reasoningTokens)} tokens
                      </span>
                    )}
                  </div>
                  <div className="model-card-reasoning-actions">
                    {status === 'complete' && <CopyButton text={reasoning} />}
                    <button
                      className="model-card-layout-toggle"
                      onClick={(e) => { e.stopPropagation(); setSideBySide(false); }}
                      title="Stack reasoning above the final answer instead of showing them side by side."
                    >
                      <ChevronDown size={14} />
                    </button>
                  </div>
                </div>
                {!reasoningCollapsed && (
                  <div
                    className={`model-card-reasoning-content ${hasReasoningPreview ? 'scroll-preview' : ''}`}
                    ref={reasoningRef}
                    onPointerDown={(event) => recordPreviewPointerDown(previewPointerRef, event)}
                    onClick={handlePreviewClick}
                  >
                    <div className="model-card-reasoning-text markdown-content">
                      <MarkdownRenderer>{reasoning}</MarkdownRenderer>
                    </div>
                  </div>
                )}
              </div>
              <div
                className={`model-card-content side-by-side ${hasContentPreview ? 'scroll-preview' : ''}`}
                ref={contentRef}
                onPointerDown={(event) => recordPreviewPointerDown(previewPointerRef, event)}
                onClick={handlePreviewClick}
              >
                <div className="markdown-content">
                  <MarkdownRenderer>{content}</MarkdownRenderer>
                  {status === 'streaming' && <span className="cursor-blink" />}
                </div>
              </div>
            </div>
          ) : (
            <>
              {reasoning && (
                <div className="model-card-reasoning">
                  <div
                    className="model-card-reasoning-header"
                    onClick={() => setReasoningCollapsed(!reasoningCollapsed)}
                    title={`Show or hide the model's reasoning trace${usage?.reasoningTokens != null ? ` (${formatTokenCount(usage.reasoningTokens)} reasoning tokens).` : '.'}`}
                  >
                    <div className="model-card-reasoning-label">
                      <Brain size={13} />
                      <span>Thinking</span>
                      {status === 'streaming' && reasoning && !content && (
                        <Loader2 size={12} className="spinning" />
                      )}
                      {usage?.reasoningTokens != null && (
                        <span className="model-card-reasoning-tokens">
                          {formatTokenCount(usage.reasoningTokens)} tokens
                        </span>
                      )}
                    </div>
                    <div className="model-card-reasoning-actions">
                      {!reasoningCollapsed && status === 'complete' && (
                        <CopyButton text={reasoning} />
                      )}
                      {content && reasoning && (
                        <button
                          className="model-card-layout-toggle"
                          onClick={(e) => { e.stopPropagation(); setSideBySide(true); }}
                          title="Show the reasoning trace and final answer side by side."
                        >
                          <ChevronUp size={14} />
                        </button>
                      )}
                      {reasoningCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                    </div>
                  </div>
                  {!reasoningCollapsed && (
                    <div
                      className={`model-card-reasoning-content ${hasReasoningPreview ? 'scroll-preview' : ''}`}
                      ref={reasoningRef}
                      onPointerDown={(event) => recordPreviewPointerDown(previewPointerRef, event)}
                      onClick={handlePreviewClick}
                    >
                      <div className="model-card-reasoning-text markdown-content">
                        <MarkdownRenderer>{reasoning}</MarkdownRenderer>
                      </div>
                      {status === 'streaming' && !content && <span className="cursor-blink" />}
                    </div>
                  )}
                </div>
              )}
              <div
                className={`model-card-content ${hasContentPreview ? 'scroll-preview' : ''}`}
                ref={contentRef}
                onPointerDown={(event) => recordPreviewPointerDown(previewPointerRef, event)}
                onClick={handlePreviewClick}
              >
                {status === 'pending' && (
                  <div className="model-card-pending">
                    <div className="pulse-dots">
                      <span /><span /><span />
                    </div>
                  </div>
                )}

                {error && (
                  <div className={`model-card-error ${displayState.tone}`}>
                    <AlertCircle size={16} />
                    <span>{error}</span>
                  </div>
                )}

                {content && status !== 'pending' && (
                  <div className="markdown-content">
                    <MarkdownRenderer>{content}</MarkdownRenderer>
                    {status === 'streaming' && <span className="cursor-blink" />}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

    </div>
  );

  return viewerOpen ? (
    <Suspense fallback={card}>
      <ResponseViewerModal open={viewerOpen} onClose={() => setViewerOpen(false)} title={displayName}>
        {card}
      </ResponseViewerModal>
    </Suspense>
  ) : card;
}

export default memo(ModelCard);
