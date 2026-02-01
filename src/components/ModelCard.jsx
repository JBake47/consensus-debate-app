import { useRef, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, AlertCircle, Loader2, RotateCcw } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import { getModelDisplayName, getProviderName, getModelColor } from '../lib/openrouter';
import { formatTokenCount, formatDuration } from '../lib/formatTokens';
import './ModelCard.css';

export default function ModelCard({ stream, roundIndex, streamIndex, isLastTurn }) {
  const { retryStream, debateInProgress } = useDebate();
  const { model, content, status, error, usage, durationMs } = stream;
  const [collapsed, setCollapsed] = useState(false);
  const contentRef = useRef(null);
  const canRetry = isLastTurn && !debateInProgress && (status === 'complete' || status === 'error');

  const color = getModelColor(model);
  const displayName = getModelDisplayName(model);
  const provider = getProviderName(model);

  // Auto-scroll while streaming
  useEffect(() => {
    if (status === 'streaming' && contentRef.current && !collapsed) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, status, collapsed]);

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
      )}
    </div>
  );
}
