import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { deriveRoundStatusFromStreams } from '../lib/retryState';
import './DebateProgressBar.css';

function getConfidenceColor(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'mid';
  return 'low';
}

function getTerminationLabel(reason) {
  if (reason === 'converged') return 'Models converged';
  if (reason === 'adaptive_convergence') return 'Adaptive convergence stop';
  if (reason === 'max_rounds_reached') return 'Max rounds reached';
  if (reason === 'cancelled') return 'Cancelled';
  if (reason === 'all_models_failed') return 'All models failed';
  if (reason === 'parallel_only') return 'Parallel responses only';
  return null;
}

export default function DebateProgressBar({ rounds, debateMetadata, compact = false }) {
  if (!rounds || rounds.length === 0) return null;

  // Collect confidence scores from convergence checks
  const confidenceScores = rounds
    .map(r => r.convergenceCheck?.confidence)
    .filter(c => c != null);
  const hasTerminationReason = Boolean(debateMetadata?.terminationReason);
  const showConsensusTrend = confidenceScores.length >= 2;
  const terminationLabel = getTerminationLabel(debateMetadata?.terminationReason);

  if (compact) {
    return (
      <div className="debate-progress-bar compact">
        <div className="progress-inline-row">
          {rounds.map((round, i) => {
            const roundStatus = deriveRoundStatusFromStreams(round.streams || [], round.status || 'pending');
            const isComplete = roundStatus === 'complete';
            const isActive = roundStatus === 'streaming';
            const isWarning = roundStatus === 'warning';
            const isError = roundStatus === 'error';
            const confidence = round.convergenceCheck?.confidence;

            return (
              <div key={i} className="progress-inline-group">
                {i > 0 && (
                  <div className={`progress-inline-separator ${isComplete || isActive || isWarning ? 'active' : ''}`} />
                )}
                <div
                  className={`progress-inline-step ${isComplete ? 'complete' : ''} ${isActive ? 'active' : ''} ${isWarning ? 'warning' : ''} ${isError ? 'error' : ''}`}
                  title={`${round.label}${confidence != null ? ` - ${confidence}% confidence` : ''}`}
                >
                  <span className="progress-inline-icon">
                    {isComplete && <CheckCircle2 size={12} />}
                    {isActive && <Loader2 size={12} className="spinning" />}
                    {isWarning && <AlertCircle size={12} />}
                    {!isComplete && !isActive && !isWarning && <Circle size={12} />}
                  </span>
                  <span className="progress-inline-label">{round.label}</span>
                  {confidence != null && (
                    <span className={`progress-inline-confidence ${getConfidenceColor(confidence)}`}>
                      {confidence}%
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {terminationLabel && (
            <div className="progress-termination">
              {terminationLabel}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`debate-progress-bar ${compact ? 'compact' : ''}`}>
      <div className="progress-track-scroll">
        <div className="progress-track">
          {rounds.map((round, i) => {
            const roundStatus = deriveRoundStatusFromStreams(round.streams || [], round.status || 'pending');
            const isComplete = roundStatus === 'complete';
            const isActive = roundStatus === 'streaming';
            const isWarning = roundStatus === 'warning';
            const isError = roundStatus === 'error';
            const confidence = round.convergenceCheck?.confidence;

            return (
              <div key={i} className="progress-step-wrapper">
                {i > 0 && (
                  <div className={`progress-connector ${isComplete || isActive || isWarning ? 'active' : ''}`} />
                )}
                <div
                  className={`progress-step ${isComplete ? 'complete' : ''} ${isActive ? 'active' : ''} ${isWarning ? 'warning' : ''} ${isError ? 'error' : ''}`}
                  title={`${round.label}${confidence != null ? ` - ${confidence}% confidence` : ''}`}
                >
                  {isComplete && <CheckCircle2 size={14} />}
                  {isActive && <Loader2 size={14} className="spinning" />}
                  {isWarning && <AlertCircle size={14} />}
                  {!isComplete && !isActive && !isWarning && <Circle size={14} />}
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
      </div>

      {(hasTerminationReason || showConsensusTrend) && (
        <div className="progress-meta-row">
          {terminationLabel && (
            <div className="progress-termination">
              {terminationLabel}
            </div>
          )}
          {showConsensusTrend && (
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
      )}
    </div>
  );
}
