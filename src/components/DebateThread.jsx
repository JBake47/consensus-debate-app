import { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp, Loader2, AlertCircle, CheckCircle2, Brain } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import { getModelDisplayName, getProviderName, getModelColor } from '../lib/openrouter';
import { formatTokenCount, formatDuration, formatCost } from '../lib/formatTokens';
import './DebateThread.css';

function ThreadMessage({ stream, roundNumber, roundLabel }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const contentRef = useRef(null);
  const { model, content, status, error, usage, durationMs, reasoning } = stream;

  const color = getModelColor(model);
  const displayName = getModelDisplayName(model);
  const provider = getProviderName(model);

  useEffect(() => {
    if (status === 'streaming' && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, status]);

  return (
    <div className={`thread-message ${status}`} style={{ '--thread-accent': color }}>
      <div className="thread-message-avatar">
        <div className="thread-avatar-dot" />
      </div>
      <div className="thread-message-body">
        <div className="thread-message-header">
          <span className="thread-message-provider">{provider}</span>
          <span className="thread-message-model">{displayName}</span>
          <span className="thread-message-round">R{roundNumber}</span>
          {status === 'streaming' && <Loader2 size={12} className="spinning" />}
          {status === 'complete' && content && (
            <CopyButton text={content} />
          )}
          {status === 'complete' && (usage || durationMs) && (
            <span className="thread-message-stats">
              {usage?.cost != null && <><span className="thread-message-cost">{formatCost(usage.cost)}</span> · </>}
              {usage?.totalTokens != null && <>{formatTokenCount(usage.totalTokens)} tok</>}
              {durationMs != null && <> · {formatDuration(durationMs)}</>}
            </span>
          )}
        </div>

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
              <pre className="thread-reasoning-text">{reasoning}</pre>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="thread-message-error">
            <AlertCircle size={14} />
            <span>{error || 'An error occurred'}</span>
          </div>
        )}

        {(status === 'streaming' || status === 'complete') && content && (
          <div className="thread-message-content markdown-content" ref={contentRef}>
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
}

function ConvergenceMessage({ convergenceCheck }) {
  if (!convergenceCheck) return null;
  const { converged, reason } = convergenceCheck;

  return (
    <div className={`thread-system-message ${converged ? 'converged' : 'not-converged'}`}>
      <CheckCircle2 size={13} />
      <span className="thread-system-label">{converged ? 'Converged' : 'Not converged'}</span>
      <span className="thread-system-reason">{reason}</span>
    </div>
  );
}

export default function DebateThread({ rounds }) {
  if (!rounds || rounds.length === 0) return null;

  return (
    <div className="debate-thread">
      {rounds.map((round, ri) => (
        <div key={ri} className="thread-round">
          <div className="thread-round-divider">
            <span className="thread-round-label">{round.label}</span>
          </div>
          <div className="thread-messages">
            {round.streams.map((stream, si) => (
              <ThreadMessage
                key={`${stream.model}-${si}`}
                stream={stream}
                roundNumber={round.roundNumber}
                roundLabel={round.label}
              />
            ))}
          </div>
          {round.convergenceCheck && (
            <ConvergenceMessage convergenceCheck={round.convergenceCheck} />
          )}
        </div>
      ))}
    </div>
  );
}
