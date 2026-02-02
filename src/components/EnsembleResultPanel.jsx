import { useState } from 'react';
import { Vote, Loader2, AlertTriangle, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import CopyButton from './CopyButton';
import { getModelDisplayName } from '../lib/openrouter';
import { formatDuration, formatCost } from '../lib/formatTokens';
import './EnsembleResultPanel.css';

function getConfidenceLevel(score) {
  if (score >= 90) return { label: 'Strong Consensus', level: 'high' };
  if (score >= 70) return { label: 'Good Agreement', level: 'high' };
  if (score >= 50) return { label: 'Partial Agreement', level: 'mid' };
  if (score >= 30) return { label: 'Significant Disagreement', level: 'low' };
  return { label: 'Major Conflict', level: 'low' };
}

export default function EnsembleResultPanel({ ensembleResult }) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  if (!ensembleResult) return null;

  const { status, confidence, outliers, agreementAreas, disagreementAreas, modelWeights, rawAnalysis, usage, durationMs, error } = ensembleResult;

  if (status === 'analyzing') {
    return (
      <div className="ensemble-panel analyzing">
        <div className="ensemble-header">
          <Vote size={15} className="ensemble-icon" />
          <span className="ensemble-title">Ensemble Vote Analysis</span>
          <span className="ensemble-status-badge analyzing">
            <Loader2 size={11} className="spinning" />
            Analyzing...
          </span>
        </div>
        <div className="ensemble-analyzing-placeholder">
          <Loader2 size={14} className="spinning" />
          Evaluating model agreement and weighting responses...
        </div>
      </div>
    );
  }

  if (status === 'error' && !confidence) {
    return (
      <div className="ensemble-panel">
        <div className="ensemble-header">
          <Vote size={15} className="ensemble-icon" />
          <span className="ensemble-title">Ensemble Vote Analysis</span>
          <span className="ensemble-status-badge error">
            <AlertCircle size={11} />
            Failed
          </span>
        </div>
        {error && <div className="confidence-description">{error}</div>}
      </div>
    );
  }

  const confidenceInfo = getConfidenceLevel(confidence);
  const hasOutliers = outliers && outliers.length > 0;
  const hasAgreement = agreementAreas && agreementAreas.length > 0;
  const hasDisagreement = disagreementAreas && disagreementAreas.length > 0;
  const hasWeights = modelWeights && Object.keys(modelWeights).length > 0;
  const hasDetails = hasAgreement || hasDisagreement || hasWeights;

  return (
    <div className="ensemble-panel">
      <div className="ensemble-header">
        <Vote size={15} className="ensemble-icon" />
        <span className="ensemble-title">Ensemble Vote Analysis</span>
        <span className="ensemble-status-badge complete">
          {rawAnalysis && <CopyButton text={rawAnalysis} />}
        </span>
      </div>

      {/* Confidence Meter */}
      <div className="confidence-section">
        <div className="confidence-header">
          <span className="confidence-label">Confidence</span>
          <span className={`confidence-value ${confidenceInfo.level}`}>
            {confidence}/100
          </span>
        </div>
        <div className="confidence-bar">
          <div
            className={`confidence-fill ${confidenceInfo.level}`}
            style={{ width: `${confidence}%` }}
          />
        </div>
        <div className="confidence-description">{confidenceInfo.label}</div>
      </div>

      {/* Outlier Badges */}
      {hasOutliers && (
        <div className="outlier-badges">
          {outliers.map((o, i) => (
            <div key={i} className="outlier-badge">
              <AlertTriangle size={11} className="outlier-icon" />
              <span className="outlier-model">{getModelDisplayName(o.model)}</span>
              {o.reason && <span className="outlier-reason">— {o.reason}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Expandable Details */}
      {hasDetails && (
        <>
          <button
            className="ensemble-details-toggle"
            onClick={() => setDetailsExpanded(!detailsExpanded)}
          >
            {detailsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {detailsExpanded ? 'Hide details' : 'Show details'}
          </button>

          {detailsExpanded && (
            <div className="ensemble-details">
              {hasAgreement && (
                <div className="ensemble-detail-section">
                  <div className="detail-section-title">Agreement Areas</div>
                  <ul className="detail-list agreement">
                    {agreementAreas.map((area, i) => (
                      <li key={i}>{area}</li>
                    ))}
                  </ul>
                </div>
              )}

              {hasDisagreement && (
                <div className="ensemble-detail-section">
                  <div className="detail-section-title">Disagreement Areas</div>
                  <ul className="detail-list disagreement">
                    {disagreementAreas.map((area, i) => (
                      <li key={i}>{area}</li>
                    ))}
                  </ul>
                </div>
              )}

              {hasWeights && (
                <div className="ensemble-detail-section">
                  <div className="detail-section-title">Model Weights</div>
                  <div className="weight-bars">
                    {Object.entries(modelWeights).map(([modelId, weight]) => (
                      <div key={modelId} className="weight-row">
                        <span className="weight-model">{getModelDisplayName(modelId)}</span>
                        <div className="weight-bar-track">
                          <div
                            className="weight-bar-fill"
                            style={{ width: `${Math.round(weight * 100)}%` }}
                          />
                        </div>
                        <span className="weight-value">{(weight * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Footer stats */}
      {(usage || durationMs) && (
        <div className="ensemble-footer">
          {usage?.cost != null && usage.cost > 0 && (
            <span className="ensemble-footer-stat">{formatCost(usage.cost)}</span>
          )}
          {durationMs != null && (
            <span className="ensemble-footer-stat">{formatDuration(durationMs)}</span>
          )}
        </div>
      )}
    </div>
  );
}
