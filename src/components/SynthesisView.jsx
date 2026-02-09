import { useRef, useEffect, useState } from 'react';
import { Sparkles, Loader2, AlertCircle, CheckCircle2, RotateCcw, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import { getModelDisplayName } from '../lib/openrouter';
import { formatFullTimestamp } from '../lib/formatDate';
import {
  aggregateCostMetas,
  computeRoundCostMeta,
  formatCostWithQuality,
  formatTokenCount,
  formatDuration,
  getCostQualityDescription,
  getUsageCostMeta,
} from '../lib/formatTokens';
import './SynthesisView.css';

function DebateInternals({ rounds, debateMetadata }) {
  const [expanded, setExpanded] = useState(false);
  if (!rounds || rounds.length === 0) return null;

  const terminationLabels = {
    converged: 'Models reached consensus',
    max_rounds_reached: 'Maximum debate rounds reached',
    all_models_failed: 'All models failed',
    cancelled: 'Debate was cancelled',
    parallel_only: 'Parallel responses only',
  };

  const roundCostMetas = rounds.map(computeRoundCostMeta);
  const totalDebateCostMeta = aggregateCostMetas(roundCostMetas);
  const totalDebateCostLabel = formatCostWithQuality(totalDebateCostMeta);

  return (
    <div className="debate-internals">
      <div className="debate-internals-header" onClick={() => setExpanded(!expanded)}>
        <div className="debate-internals-label">
          <Eye size={13} />
          <span>Debate Internals</span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </div>
      {expanded && (
        <div className="debate-internals-content">
          <div className="internals-summary">
            <div className="internals-stat">
              <span className="internals-stat-label">Rounds</span>
              <span className="internals-stat-value">{debateMetadata?.totalRounds || rounds.length}</span>
            </div>
            <div className="internals-stat">
              <span className="internals-stat-label">Outcome</span>
              <span className={`internals-stat-value ${debateMetadata?.converged ? 'converged' : ''}`}>
                {debateMetadata?.converged ? 'Converged' : 'Did not converge'}
              </span>
            </div>
            {debateMetadata?.terminationReason && (
              <div className="internals-stat">
                <span className="internals-stat-label">Ended because</span>
                <span className="internals-stat-value">
                  {terminationLabels[debateMetadata.terminationReason] || debateMetadata.terminationReason}
                </span>
              </div>
            )}
            {totalDebateCostLabel && (
              <div className="internals-stat">
                <span className="internals-stat-label">Debate Cost</span>
                <span
                  className={`internals-stat-value internals-cost ${totalDebateCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                  title={getCostQualityDescription(totalDebateCostMeta.quality)}
                >
                  {totalDebateCostLabel}
                </span>
              </div>
            )}
          </div>

          <div className="internals-timeline">
            {rounds.map((round, i) => {
              const completedModels = round.streams.filter(s => s.status === 'complete' || (s.content && s.status !== 'error'));
              const failedModels = round.streams.filter(s => s.status === 'error');
              const roundCostMeta = roundCostMetas[i];
              const roundCostLabel = formatCostWithQuality(roundCostMeta);
              const cc = round.convergenceCheck;

              return (
                <div key={i} className="internals-round">
                  <div className="internals-round-header">
                    <span className={`internals-round-dot ${round.status}`} />
                    <span className="internals-round-label">{round.label}</span>
                    {roundCostLabel && (
                      <span
                        className={`internals-round-cost ${roundCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                        title={getCostQualityDescription(roundCostMeta.quality)}
                      >
                        {roundCostLabel}
                      </span>
                    )}
                    <span className="internals-round-models">
                      {completedModels.length}/{round.streams.length} models responded
                      {failedModels.length > 0 && (
                        <span className="internals-failed"> ({failedModels.length} failed)</span>
                      )}
                    </span>
                  </div>
                  {round.streams.map((stream, si) => {
                    const streamCostMeta = getUsageCostMeta(stream.usage, stream.model);
                    const streamCostLabel = formatCostWithQuality(streamCostMeta);
                    return (
                      <div key={si} className="internals-stream-row">
                        <span className={`internals-stream-status ${stream.status}`}>
                          {stream.status === 'complete' ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
                        </span>
                        <span className="internals-stream-model">{getModelDisplayName(stream.model)}</span>
                        {streamCostLabel && (
                          <span
                            className={`internals-stream-cost ${streamCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                            title={getCostQualityDescription(streamCostMeta.quality)}
                          >
                            {streamCostLabel}
                          </span>
                        )}
                        {stream.usage?.totalTokens != null && (
                          <span className="internals-stream-tokens">{formatTokenCount(stream.usage.totalTokens)} tokens</span>
                        )}
                        {stream.durationMs != null && (
                          <span className="internals-stream-duration">{formatDuration(stream.durationMs)}</span>
                        )}
                        {stream.error && (
                          <span className="internals-stream-error">{stream.error}</span>
                        )}
                      </div>
                    );
                  })}
                  {cc && cc.converged !== null && (
                    <div className={`internals-convergence ${cc.converged ? 'converged' : 'diverged'}`}>
                      <span className="internals-convergence-label">
                        {cc.converged ? 'Converged' : 'Diverged'}
                      </span>
                      {cc.reason && <span className="internals-convergence-reason">{cc.reason}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SynthesisView({ synthesis, debateMetadata, isLastTurn, rounds, ensembleResult }) {
  const { retrySynthesis, debateInProgress } = useDebate();
  const { model, content, status, error } = synthesis;
  const canRetry = isLastTurn && !debateInProgress && (status === 'complete' || status === 'error');
  const contentRef = useRef(null);
  const synthesisCostMeta = getUsageCostMeta(synthesis.usage, synthesis.model || model || '');
  const synthesisCostLabel = formatCostWithQuality(synthesisCostMeta);

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
          <span className="synthesis-title">{ensembleResult ? 'Ensemble Synthesis' : 'Synthesized Answer'}</span>
          <span className="synthesis-model">{getModelDisplayName(model)}</span>
        </div>
        <div className="synthesis-badges">
          {status === 'complete' && content && (
            <CopyButton text={content} />
          )}
          {canRetry && (
            <button
              className="synthesis-retry-btn"
              onClick={retrySynthesis}
              title="Retry synthesis"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {debateMetadata && debateMetadata.totalRounds > 0 && (
            <div className="synthesis-meta-badge">
              <RotateCcw size={11} />
              {debateMetadata.totalRounds} round{debateMetadata.totalRounds !== 1 ? 's' : ''}
            </div>
          )}
          {ensembleResult?.status === 'complete' && ensembleResult.confidence != null && (
            <div className={`synthesis-meta-badge ${ensembleResult.confidence >= 70 ? 'converged' : ''}`}>
              <CheckCircle2 size={11} />
              {ensembleResult.confidence}% confidence
            </div>
          )}
          {debateMetadata?.converged && !ensembleResult && (
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
              {synthesisCostLabel && (
                <>
                  <span
                    className={`synthesis-cost ${synthesisCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                    title={getCostQualityDescription(synthesisCostMeta.quality)}
                  >
                    {synthesisCostLabel}
                  </span>
                  {' | '}
                </>
              )}
              {synthesis.usage?.totalTokens != null && <>{formatTokenCount(synthesis.usage.totalTokens)} tokens</>}
              {synthesis.usage?.totalTokens != null && synthesis.durationMs != null && ' | '}
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

      {status === 'complete' && rounds && (
        <DebateInternals rounds={rounds} debateMetadata={debateMetadata} />
      )}
    </div>
  );
}
