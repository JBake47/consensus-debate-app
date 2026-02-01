import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import ModelCard from './ModelCard';
import ConvergenceBadge from './ConvergenceBadge';
import './RoundSection.css';

export default function RoundSection({ round, isLatest, roundIndex, isLastTurn }) {
  const [collapsed, setCollapsed] = useState(false);
  const { label, status, streams, convergenceCheck, roundNumber } = round;

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
        </div>
        <div className="round-header-right">
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
