import { useState } from 'react';
import { User, Globe, ChevronDown, ChevronUp, Loader2, AlertCircle, FileText, Image as ImageIcon, Pencil, RotateCcw, LayoutGrid, MessageSquare } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import { formatFileSize } from '../lib/fileProcessor';
import RoundSection from './RoundSection';
import DebateThread from './DebateThread';
import DebateProgressBar from './DebateProgressBar';
import SynthesisView from './SynthesisView';
import { getModelDisplayName } from '../lib/openrouter';
import { formatFullTimestamp } from '../lib/formatDate';
import { formatDuration, formatCost, computeTurnCost } from '../lib/formatTokens';
import './DebateView.css';

function WebSearchPanel({ webSearchResult }) {
  const [collapsed, setCollapsed] = useState(true);
  const { status, content, model, error, durationMs } = webSearchResult;

  return (
    <div className={`web-search-panel glass-panel ${status}`}>
      <div className="web-search-header" onClick={() => status === 'complete' && setCollapsed(!collapsed)}>
        <div className="web-search-header-left">
          <Globe size={14} className="web-search-icon" />
          <span className="web-search-label">Web Search</span>
          {model && <span className="web-search-model">{getModelDisplayName(model)}</span>}
        </div>
        <div className="web-search-header-right">
          {status === 'searching' && (
            <span className="web-search-badge searching">
              <Loader2 size={12} className="spinning" />
              Searching...
            </span>
          )}
          {status === 'complete' && (
            <>
              <span className="web-search-badge complete">Done</span>
              {durationMs != null && (
                <span className="web-search-duration">{formatDuration(durationMs)}</span>
              )}
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </>
          )}
          {status === 'error' && (
            <span className="web-search-badge error">
              <AlertCircle size={12} />
              Failed
            </span>
          )}
        </div>
      </div>
      {status === 'complete' && !collapsed && content && (
        <div className="web-search-content markdown-content">
          <MarkdownRenderer>{content}</MarkdownRenderer>
        </div>
      )}
      {status === 'error' && error && (
        <div className="web-search-error">{error}</div>
      )}
    </div>
  );
}

export default function DebateView({ turn, isLastTurn }) {
  const { editLastTurn, retryLastTurn, debateInProgress } = useDebate();
  const [viewMode, setViewMode] = useState('cards'); // 'cards' or 'thread'
  const hasRounds = turn.rounds && turn.rounds.length > 0;

  return (
    <div className="debate-turn">
      <div className="user-message">
        <div className="user-avatar">
          <User size={14} />
        </div>
        <div className="user-message-body">
          <div className="user-message-header">
            <span className="user-label">You</span>
            {turn.timestamp && (
              <span className="user-timestamp">{formatFullTimestamp(turn.timestamp)}</span>
            )}
            {isLastTurn && !debateInProgress && (
              <div className="user-message-actions">
                <button
                  className="user-action-btn"
                  onClick={editLastTurn}
                  title="Edit this message"
                >
                  <Pencil size={14} />
                </button>
                {hasRounds && (
                  <button
                    className="user-action-btn"
                    onClick={retryLastTurn}
                    title="Retry this turn"
                  >
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="user-text markdown-content">
            <MarkdownRenderer>{turn.userPrompt}</MarkdownRenderer>
          </div>
          {turn.attachments && turn.attachments.length > 0 && (
            <div className="user-attachments">
              {turn.attachments.map((att, i) => (
                <div key={i} className={`user-attachment-chip ${att.category}`}>
                  {att.category === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}
                  <span className="user-attachment-name">{att.name}</span>
                  <span className="user-attachment-size">{formatFileSize(att.size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {turn.webSearchResult && (
        <WebSearchPanel webSearchResult={turn.webSearchResult} />
      )}

      {hasRounds && (
        <>
          <div className="debate-controls">
            <DebateProgressBar rounds={turn.rounds} debateMetadata={turn.debateMetadata} />
            {turn.rounds.length > 0 && (
              <div className="debate-view-toggle">
                <button
                  className={`view-toggle-btn ${viewMode === 'cards' ? 'active' : ''}`}
                  onClick={() => setViewMode('cards')}
                  title="Card view"
                >
                  <LayoutGrid size={14} />
                  <span>Cards</span>
                </button>
                <button
                  className={`view-toggle-btn ${viewMode === 'thread' ? 'active' : ''}`}
                  onClick={() => setViewMode('thread')}
                  title="Debate thread view"
                >
                  <MessageSquare size={14} />
                  <span>Thread</span>
                </button>
              </div>
            )}
          </div>

          {viewMode === 'cards' ? (
            <div className="debate-rounds">
              {turn.rounds.map((round, i) => (
                <RoundSection
                  key={round.roundNumber}
                  round={round}
                  isLatest={i === turn.rounds.length - 1}
                  roundIndex={i}
                  isLastTurn={isLastTurn}
                />
              ))}
            </div>
          ) : (
            <DebateThread rounds={turn.rounds} />
          )}
        </>
      )}

      {turn.synthesis && turn.synthesis.status !== 'pending' && (
        <SynthesisView synthesis={turn.synthesis} debateMetadata={turn.debateMetadata} />
      )}

      {turn.synthesis?.status === 'complete' && computeTurnCost(turn) > 0 && (
        <div className="turn-cost-summary">
          Turn cost: <span className="turn-cost-value">{formatCost(computeTurnCost(turn))}</span>
        </div>
      )}
    </div>
  );
}
