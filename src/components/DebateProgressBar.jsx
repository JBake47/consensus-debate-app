import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import './DebateProgressBar.css';

function getConfidenceColor(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'mid';
  return 'low';
}

export default function DebateProgressBar({ rounds, debateMetadata }) {
  if (!rounds || rounds.length === 0) return null;

  // Collect confidence scores from convergence checks
  const confidenceScores = rounds
    .map(r => r.convergenceCheck?.confidence)
    .filter(c => c != null);

  return (
    <div className="debate-progress-bar">
      <div className="progress-track">
        {rounds.map((round, i) => {
          const isComplete = round.status === 'complete';
          const isActive = round.status === 'streaming';
          const isError = round.status === 'error';
          const confidence = round.convergenceCheck?.confidence;

          return (
            <div key={i} className="progress-step-wrapper">
              {i > 0 && (
                <div className={`progress-connector ${isComplete || isActive ? 'active' : ''}`} />
              )}
              <div
                className={`progress-step ${isComplete ? 'complete' : ''} ${isActive ? 'active' : ''} ${isError ? 'error' : ''}`}
                title={`${round.label}${confidence != null ? ` — ${confidence}% confidence` : ''}`}
              >
                {isComplete && <CheckCircle2 size={14} />}
                {isActive && <Loader2 size={14} className="spinning" />}
                {!isComplete && !isActive && <Circle size={14} />}
              </div>
              <span className="progress-step-label">{round.label}</span>
              {confidence != null && (
                <span className={`progress-step-confidence ${getConfidenceColor(confidence)}`}>
                  {confidence}%
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="progress-meta-row">
        {debateMetadata?.terminationReason && (
          <div className="progress-termination">
            {debateMetadata.terminationReason === 'converged' && 'Models converged'}
            {debateMetadata.terminationReason === 'max_rounds_reached' && 'Max rounds reached'}
            {debateMetadata.terminationReason === 'cancelled' && 'Cancelled'}
            {debateMetadata.terminationReason === 'all_models_failed' && 'All models failed'}
            {debateMetadata.terminationReason === 'parallel_only' && 'Parallel responses only'}
          </div>
        )}
        {confidenceScores.length >= 2 && (
          <div className="consensus-trend">
            <span className="consensus-trend-label">Consensus trend</span>
            <div className="consensus-trend-bars">
              {confidenceScores.map((score, i) => (
                <div key={i} className="consensus-trend-bar-wrapper" title={`Round ${i + 2}: ${score}%`}>
                  <div
                    className={`consensus-trend-bar ${getConfidenceColor(score)}`}
                    style={{ height: `${Math.max(4, score * 0.24)}px` }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
