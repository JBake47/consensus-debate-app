import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import './DebateProgressBar.css';

export default function DebateProgressBar({ rounds, debateMetadata }) {
  if (!rounds || rounds.length === 0) return null;

  return (
    <div className="debate-progress-bar">
      <div className="progress-track">
        {rounds.map((round, i) => {
          const isComplete = round.status === 'complete';
          const isActive = round.status === 'streaming';
          const isError = round.status === 'error';

          return (
            <div key={i} className="progress-step-wrapper">
              {i > 0 && (
                <div className={`progress-connector ${isComplete || isActive ? 'active' : ''}`} />
              )}
              <div
                className={`progress-step ${isComplete ? 'complete' : ''} ${isActive ? 'active' : ''} ${isError ? 'error' : ''}`}
                title={round.label}
              >
                {isComplete && <CheckCircle2 size={14} />}
                {isActive && <Loader2 size={14} className="spinning" />}
                {!isComplete && !isActive && <Circle size={14} />}
              </div>
              <span className="progress-step-label">{round.label}</span>
            </div>
          );
        })}
      </div>
      {debateMetadata?.terminationReason && (
        <div className="progress-termination">
          {debateMetadata.terminationReason === 'converged' && 'Models converged'}
          {debateMetadata.terminationReason === 'max_rounds_reached' && 'Max rounds reached'}
          {debateMetadata.terminationReason === 'cancelled' && 'Cancelled'}
          {debateMetadata.terminationReason === 'all_models_failed' && 'All models failed'}
        </div>
      )}
    </div>
  );
}
