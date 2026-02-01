import { useRef, useEffect } from 'react';
import { Sparkles, Loader2, AlertCircle, CheckCircle2, RotateCcw } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import { getModelDisplayName } from '../lib/openrouter';
import { formatFullTimestamp } from '../lib/formatDate';
import { formatTokenCount, formatDuration, formatCost } from '../lib/formatTokens';
import './SynthesisView.css';

export default function SynthesisView({ synthesis, debateMetadata }) {
  const { model, content, status, error } = synthesis;
  const contentRef = useRef(null);

  useEffect(() => {
    const el = contentRef.current;
    if (status === 'streaming' && el) {
      const threshold = 80;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [content, status]);

  return (
    <div className={`synthesis-view glass-panel ${status}`}>
      <div className="synthesis-header">
        <div className="synthesis-icon">
          <Sparkles size={16} />
        </div>
        <div className="synthesis-title-area">
          <span className="synthesis-title">Synthesized Answer</span>
          <span className="synthesis-model">{getModelDisplayName(model)}</span>
        </div>
        <div className="synthesis-badges">
          {debateMetadata && debateMetadata.totalRounds > 0 && (
            <div className="synthesis-meta-badge">
              <RotateCcw size={11} />
              {debateMetadata.totalRounds} round{debateMetadata.totalRounds !== 1 ? 's' : ''}
            </div>
          )}
          {debateMetadata?.converged && (
            <div className="synthesis-meta-badge converged">
              <CheckCircle2 size={11} />
              Converged
            </div>
          )}
          {status === 'streaming' && (
            <div className="synthesis-streaming-badge">
              <Loader2 size={12} className="spinning" />
              Synthesizing...
            </div>
          )}
          {status === 'complete' && (synthesis.usage || synthesis.durationMs) && (
            <div className="synthesis-meta-badge">
              {synthesis.usage?.cost != null && <><span className="synthesis-cost">{formatCost(synthesis.usage.cost)}</span> · </>}
              {synthesis.usage?.totalTokens != null && <>{formatTokenCount(synthesis.usage.totalTokens)} tokens</>}
              {synthesis.usage?.totalTokens != null && synthesis.durationMs != null && ' · '}
              {synthesis.durationMs != null && formatDuration(synthesis.durationMs)}
            </div>
          )}
          {status === 'complete' && synthesis.completedAt && (
            <span className="synthesis-timestamp">{formatFullTimestamp(synthesis.completedAt)}</span>
          )}
        </div>
      </div>

      <div className="synthesis-content" ref={contentRef}>
        {status === 'pending' && (
          <div className="synthesis-pending">
            Waiting for debate rounds to complete...
          </div>
        )}

        {status === 'error' && (
          <div className="synthesis-error">
            <AlertCircle size={16} />
            <span>{error || 'Synthesis failed'}</span>
          </div>
        )}

        {(status === 'streaming' || status === 'complete') && content && (
          <div className="markdown-content">
            <MarkdownRenderer>{content}</MarkdownRenderer>
            {status === 'streaming' && <span className="cursor-blink" />}
          </div>
        )}
      </div>
    </div>
  );
}
