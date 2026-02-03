import { useRef, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, AlertCircle, Loader2, RotateCcw, Brain } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import { getModelDisplayName, getProviderName, getModelColor } from '../lib/openrouter';
import { formatTokenCount, formatDuration, formatCost } from '../lib/formatTokens';
import './ModelCard.css';

function isReasoningModel(modelId) {
  const id = modelId.toLowerCase();
  return /\bo[13]\b/.test(id) || id.includes('deepseek-r1') || id.includes('qwq') || id.includes('reasoner');
}

export default function ModelCard({ stream, roundIndex, streamIndex, isLastTurn, allowRetry = true }) {
  const { retryStream, debateInProgress } = useDebate();
  const { model, content, status, error, usage, durationMs, reasoning } = stream;
  const [collapsed, setCollapsed] = useState(false);
  const reasoningModel = isReasoningModel(model);
  const [reasoningCollapsed, setReasoningCollapsed] = useState(!reasoningModel);
  const [sideBySide, setSideBySide] = useState(reasoningModel);
  const contentRef = useRef(null);
  const reasoningRef = useRef(null);
  const canRetry = allowRetry && isLastTurn && !debateInProgress && (status === 'complete' || status === 'error');

  const color = getModelColor(model);
  const displayName = getModelDisplayName(model);
  const provider = getProviderName(model);

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

  const statusLabel = {
    pending: 'Waiting...',
    streaming: 'Thinking...',
    complete: 'Complete',
    error: 'Failed',
  }[status];

  return (
    <div
      className={`model-card glass-panel ${status}`}
      style={{ '--card-accent': color }}
    >
      <div className="model-card-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="model-card-info">
          <div className="model-card-accent-dot" />
          <div className="model-card-names">
            <span className="model-card-provider">{provider}</span>
            <span className="model-card-name">{displayName}</span>
          </div>
        </div>
        <div className="model-card-status-area">
          {status === 'complete' && content && (
            <CopyButton text={content} />
          )}
          {canRetry && (
            <button
              className="model-card-retry"
              onClick={(e) => { e.stopPropagation(); retryStream(roundIndex, streamIndex); }}
              title="Retry this model"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {status === 'complete' && (usage || durationMs) && (
            <span className="model-card-stats">
              {usage?.cost != null && <><span className="model-card-cost">{formatCost(usage.cost)}</span> · </>}
              {usage?.totalTokens != null && <>{formatTokenCount(usage.totalTokens)} tokens</>}
              {usage?.totalTokens != null && durationMs != null && ' · '}
              {durationMs != null && formatDuration(durationMs)}
            </span>
          )}
          <span className={`model-card-status ${status}`}>
            {status === 'streaming' && <Loader2 size={12} className="spinning" />}
            {status === 'error' && <AlertCircle size={12} />}
            {statusLabel}
          </span>
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </div>
      </div>

      {!collapsed && (
        <>
          {reasoning && sideBySide && content ? (
            <div className="model-card-side-by-side">
              <div className="model-card-reasoning side-by-side">
                <div
                  className="model-card-reasoning-header"
                  onClick={() => setReasoningCollapsed(!reasoningCollapsed)}
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
                      title="Stack vertically"
                    >
                      <ChevronDown size={14} />
                    </button>
                  </div>
                </div>
                {!reasoningCollapsed && (
                  <div className="model-card-reasoning-content" ref={reasoningRef}>
                    <div className="model-card-reasoning-text markdown-content">
                      <MarkdownRenderer>{reasoning}</MarkdownRenderer>
                    </div>
                  </div>
                )}
              </div>
              <div className="model-card-content side-by-side" ref={contentRef}>
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
                          title="Show side by side"
                        >
                          <ChevronUp size={14} />
                        </button>
                      )}
                      {reasoningCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                    </div>
                  </div>
                  {!reasoningCollapsed && (
                    <div className="model-card-reasoning-content" ref={reasoningRef}>
                      <div className="model-card-reasoning-text markdown-content">
                        <MarkdownRenderer>{reasoning}</MarkdownRenderer>
                      </div>
                      {status === 'streaming' && !content && <span className="cursor-blink" />}
                    </div>
                  )}
                </div>
              )}
              <div className="model-card-content" ref={contentRef}>
                {status === 'pending' && (
                  <div className="model-card-pending">
                    <div className="pulse-dots">
                      <span /><span /><span />
                    </div>
                  </div>
                )}

                {status === 'error' && (
                  <div className="model-card-error">
                    <AlertCircle size={16} />
                    <span>{error || 'An error occurred'}</span>
                  </div>
                )}

                {(status === 'streaming' || status === 'complete') && content && (
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
}
