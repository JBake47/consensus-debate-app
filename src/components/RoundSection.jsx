import { memo, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, CheckCircle2, AlertCircle, RotateCcw, GitBranchPlus } from 'lucide-react';
import { useDebateActions, useDebateConversations } from '../context/DebateContext';
import ModelCard from './ModelCard';
import ConvergenceBadge from './ConvergenceBadge';
import ConvergencePanel from './ConvergencePanel';
import {
  computeRoundCostMeta,
  formatCostWithQuality,
  getCostQualityDescription,
} from '../lib/formatTokens';
import { deriveRoundStatusFromStreams, getRetryScopeDescription } from '../lib/retryState';
import './RoundSection.css';

function RoundSection({
  round,
  isLatest,
  roundIndex,
  isLastTurn,
  allowRetry = true,
  allowRoundRetry = allowRetry,
  allowStreamRetry = allowRetry,
  turnMode = 'debate',
  totalRounds = 1,
}) {
  const { retryRound, branchFromRound } = useDebateActions();
  const { debateInProgress } = useDebateConversations();
  const [collapsed, setCollapsed] = useState(false);
  const { label, status, streams, convergenceCheck, roundNumber } = round;
  const roundStatus = deriveRoundStatusFromStreams(streams, status);
  const roundCostMeta = computeRoundCostMeta(round);
  const roundCostLabel = formatCostWithQuality(roundCostMeta);

  const hasIssueStreams = roundStatus === 'warning' || roundStatus === 'error';
  const canRetry = allowRoundRetry && isLastTurn && !debateInProgress && (roundStatus === 'warning' || roundStatus === 'error' || roundStatus === 'complete');
  const canBranch = isLastTurn && !debateInProgress && roundStatus !== 'streaming' && roundStatus !== 'pending';
  const retryScopeLabel = getRetryScopeDescription({
    scope: 'round',
    mode: turnMode,
    roundNumber,
    totalRounds,
    hasFailures: hasIssueStreams,
  });

  const statusIcon = {
    pending: null,
    streaming: <Loader2 size={14} className="spinning" />,
    complete: <CheckCircle2 size={14} />,
    warning: <AlertCircle size={14} />,
    error: <AlertCircle size={14} />,
  }[roundStatus];

  return (
    <div className={`round-section ${roundStatus} ${collapsed ? 'collapsed' : ''}`}>
      <div className="round-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="round-header-left">
          <span className={`round-status-icon ${roundStatus}`}>{statusIcon}</span>
          <span className="round-label">{label}</span>
          <span className="round-number">Round {roundNumber}</span>
          {(roundStatus === 'complete' || roundStatus === 'warning') && roundCostLabel && (
            <span
              className={`round-cost ${roundCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
              title={getCostQualityDescription(roundCostMeta.quality)}
            >
              {roundCostLabel}
            </span>
          )}
        </div>
        <div className="round-header-right">
          {canRetry && (
            <button
              className="round-retry-btn"
              onClick={(e) => {
                e.stopPropagation();
                retryRound(roundIndex, {
                  forceRefresh: e.shiftKey,
                  retryErroredCompleted: hasIssueStreams,
                  redoRound: !hasIssueStreams,
                });
              }}
              title={`${retryScopeLabel} Shift bypasses cache.`}
            >
              <RotateCcw size={13} />
              <span>{hasIssueStreams ? 'Repair Round' : 'Redo Round'}</span>
            </button>
          )}
          {canBranch && (
            <button
              className="round-branch-btn"
              onClick={(e) => {
                e.stopPropagation();
                branchFromRound(roundIndex);
              }}
              title="Create a new branch from this round"
            >
              <GitBranchPlus size={13} />
              <span>Branch</span>
            </button>
          )}
          {convergenceCheck && <ConvergenceBadge convergenceCheck={convergenceCheck} />}
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </div>
      </div>

      {!collapsed && (
        <div className="round-body">
          {canRetry && hasIssueStreams && (
            <div className={`round-retry-scope ${roundStatus}`}>
              {retryScopeLabel}
            </div>
          )}
          <div className="round-streams">
            {streams.map((stream, i) => (
              <ModelCard
                key={`${stream.model}-${i}`}
                stream={stream}
                roundIndex={roundIndex}
                streamIndex={i}
                isLastTurn={isLastTurn}
                allowRetry={allowStreamRetry}
                turnMode={turnMode}
                totalRounds={totalRounds}
                roundNumber={roundNumber}
                roundModels={streams.map((item) => item.model)}
              />
            ))}
          </div>
          {convergenceCheck && (convergenceCheck.agreements?.length > 0 || convergenceCheck.disagreements?.length > 0 || convergenceCheck.confidence != null) && (
            <ConvergencePanel convergenceCheck={convergenceCheck} roundNumber={roundNumber} />
          )}
        </div>
      )}
    </div>
  );
}

export default memo(RoundSection);
