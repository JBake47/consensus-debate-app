import { useState } from 'react';
import { ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import CopyButton from './CopyButton';
import { getModelDisplayName } from '../lib/openrouter';
import './ConvergencePanel.css';

function getConfidenceLevel(score) {
  if (score >= 80) return { label: 'Strong Agreement', level: 'high' };
  if (score >= 60) return { label: 'Moderate Agreement', level: 'mid' };
  if (score >= 40) return { label: 'Partial Agreement', level: 'low' };
  return { label: 'Significant Disagreement', level: 'low' };
}

export default function ConvergencePanel({ convergenceCheck, roundNumber }) {
  const [expanded, setExpanded] = useState(false);

  if (!convergenceCheck) return null;

  const { converged, confidence, reason, agreements, disagreements, rawResponse } = convergenceCheck;

  if (converged === null) {
    return (
      <div className="convergence-panel checking">
        <div className="convergence-panel-header">
          <Loader2 size={14} className="spinning" />
          <span className="convergence-panel-title">Checking convergence after Round {roundNumber}...</span>
        </div>
      </div>
    );
  }

  const hasAgreements = agreements && agreements.length > 0;
  const hasDisagreements = disagreements && disagreements.length > 0;
  const hasDetails = hasAgreements || hasDisagreements;
  const confidenceInfo = confidence != null ? getConfidenceLevel(confidence) : null;

  return (
    <div className={`convergence-panel ${converged ? 'converged' : 'diverged'}`}>
      <div
        className="convergence-panel-header"
        onClick={() => hasDetails && setExpanded(!expanded)}
        style={{ cursor: hasDetails ? 'pointer' : 'default' }}
      >
        <div className="convergence-panel-left">
          {converged ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          <span className="convergence-panel-title">
            {converged ? 'Converged' : 'Diverged'} — Round {roundNumber}
          </span>
          {reason && <span className="convergence-panel-reason">{reason}</span>}
        </div>
        <div className="convergence-panel-right">
          {confidence != null && (
            <div className="convergence-confidence-chip">
              <div className="convergence-mini-bar">
                <div
                  className={`convergence-mini-fill ${confidenceInfo.level}`}
                  style={{ width: `${confidence}%` }}
                />
              </div>
              <span className={`convergence-confidence-value ${confidenceInfo.level}`}>{confidence}%</span>
            </div>
          )}
          {rawResponse && <CopyButton text={rawResponse} />}
          {hasDetails && (expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
        </div>
      </div>

      {expanded && hasDetails && (
        <div className="convergence-panel-body">
          {hasAgreements && (
            <div className="convergence-detail-section">
              <div className="convergence-detail-title agreement">Areas of Agreement</div>
              <ul className="convergence-detail-list agreement">
                {agreements.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}

          {hasDisagreements && (
            <div className="convergence-detail-section">
              <div className="convergence-detail-title disagreement">Points of Disagreement</div>
              <div className="disagreement-cards">
                {disagreements.map((d, i) => (
                  <div key={i} className="disagreement-card">
                    <div className="disagreement-point">{d.point || d}</div>
                    {d.models && typeof d.models === 'object' && (
                      <div className="disagreement-positions">
                        {Object.entries(d.models).map(([modelId, position]) => (
                          <div key={modelId} className="disagreement-position">
                            <span className="disagreement-model">{getModelDisplayName(modelId)}</span>
                            <span className="disagreement-stance">{position}</span>
                          </div>
                        ))}
                      </div>
                    )}
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
