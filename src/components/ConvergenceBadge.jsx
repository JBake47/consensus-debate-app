import { useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import CopyButton from './CopyButton';
import './ConvergenceBadge.css';

export default function ConvergenceBadge({ convergenceCheck }) {
  const [expanded, setExpanded] = useState(false);
  if (!convergenceCheck) return null;

  const { converged, reason, rawResponse } = convergenceCheck;

  // Still checking (converged is null)
  if (converged === null) {
    return (
      <div className="convergence-badge checking">
        <Loader2 size={12} className="spinning" />
        <span>Checking convergence...</span>
      </div>
    );
  }

  const hasDetails = reason || rawResponse;
  const copyText = rawResponse || reason || '';

  return (
    <div className="convergence-wrapper">
      <div
        className={`convergence-badge ${converged ? 'converged' : 'diverged'} ${hasDetails ? 'clickable' : ''}`}
        onClick={(e) => {
          if (hasDetails) {
            e.stopPropagation();
            setExpanded(!expanded);
          }
        }}
      >
        {converged ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
        <span>{converged ? 'Converged' : 'Diverged'}</span>
        {hasDetails && (expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </div>
      {expanded && hasDetails && (
        <div className="convergence-details" onClick={(e) => e.stopPropagation()}>
          <div className="convergence-details-header">
            <CopyButton text={copyText} />
          </div>
          {reason && (
            <div className="convergence-reason">
              <span className="convergence-detail-label">Analysis</span>
              <p>{reason}</p>
            </div>
          )}
          {rawResponse && rawResponse !== reason && (
            <div className="convergence-raw">
              <span className="convergence-detail-label">Raw Response</span>
              <pre>{rawResponse}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
