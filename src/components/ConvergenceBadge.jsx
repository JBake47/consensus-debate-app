import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import './ConvergenceBadge.css';

export default function ConvergenceBadge({ convergenceCheck }) {
  if (!convergenceCheck) return null;

  const { converged, reason } = convergenceCheck;

  // Still checking (converged is null)
  if (converged === null) {
    return (
      <div className="convergence-badge checking" title={reason}>
        <Loader2 size={12} className="spinning" />
        <span>Checking convergence...</span>
      </div>
    );
  }

  if (converged) {
    return (
      <div className="convergence-badge converged" title={reason}>
        <CheckCircle2 size={12} />
        <span>Converged</span>
      </div>
    );
  }

  return (
    <div className="convergence-badge diverged" title={reason}>
      <AlertTriangle size={12} />
      <span>Diverged</span>
    </div>
  );
}
