import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, CheckCircle2, AlertCircle, RotateCcw } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import ModelCard from './ModelCard';
import ConvergenceBadge from './ConvergenceBadge';
import { formatCost } from '../lib/formatTokens';
import './RoundSection.css';

export default function RoundSection({ round, isLatest, roundIndex, isLastTurn }) {
  const { retryRound, debateInProgress } = useDebate();
  const [collapsed, setCollapsed] = useState(false);
  const { label, status, streams, convergenceCheck, roundNumber } = round;

  let roundCost = 0;
  for (const s of streams) {
    if (s.usage?.cost != null) roundCost += s.usage.cost;
  }

  const hasFailedStreams = streams.some(s => s.status === 'error' || (s.status !== 'complete' && s.status !== 'streaming'));
  const canRetry = isLastTurn && !debateInProgress && (status === 'error' || status === 'complete' || hasFailedStreams);

  const statusIcon = {
    pending: null,
    streaming: <Loader2 size={14} className="spinning" />,
    complete: <CheckCircle2 size={14} />,
    error: <AlertCircle size={14} />,
  }[status];

  return (
    <div className={`round-section ${status} ${collapsed ? 'collapsed' : ''}`}>
      <div className="round-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="round-header-left">
          <span className={`round-status-icon ${status}`}>{statusIcon}</span>
          <span className="round-label">{label}</span>
          <span className="round-number">Round {roundNumber}</span>
          {status === 'complete' && roundCost > 0 && (
            <span className="round-cost">{formatCost(roundCost)}</span>
          )}
        </div>
        <div className="round-header-right">
          {canRetry && (
            <button
              className="round-retry-btn"
              onClick={(e) => { e.stopPropagation(); retryRound(roundIndex); }}
              title={hasFailedStreams ? 'Retry failed models and continue debate' : 'Redo from this round'}
            >
              <RotateCcw size={13} />
            </button>
          )}
          {convergenceCheck && <ConvergenceBadge convergenceCheck={convergenceCheck} />}
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </div>
      </div>

      {!collapsed && (
        <div className="round-body">
          <div className="round-streams">
            {streams.map((stream, i) => (
              <ModelCard key={`${stream.model}-${i}`} stream={stream} roundIndex={roundIndex} streamIndex={i} isLastTurn={isLastTurn} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
