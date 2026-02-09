import { useState } from 'react';
import { User, Globe, ChevronDown, ChevronUp, Loader2, AlertCircle, FileText, Image as ImageIcon, Pencil, RotateCcw, LayoutGrid, MessageSquare } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import { formatFileSize } from '../lib/fileProcessor';
import ModelCard from './ModelCard';
import RoundSection from './RoundSection';
import DebateThread from './DebateThread';
import DebateProgressBar from './DebateProgressBar';
import SynthesisView from './SynthesisView';
import EnsembleResultPanel from './EnsembleResultPanel';
import AttachmentViewer from './AttachmentViewer';
import { getModelDisplayName } from '../lib/openrouter';
import { formatFullTimestamp } from '../lib/formatDate';
import {
  computeTurnCostMeta,
  formatCostWithQuality,
  formatDuration,
  getCostQualityDescription,
} from '../lib/formatTokens';
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
              {content && <CopyButton text={content} />}
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
  const [viewerAttachment, setViewerAttachment] = useState(null);
  const hasRounds = turn.rounds && turn.rounds.length > 0;
  const isDirectMode = turn.mode === 'direct';
  const isParallelMode = turn.mode === 'parallel';
  // Ensemble turns have multiple streams in their round or an ensembleResult
  const isEnsembleTurn = isDirectMode && (
    turn.ensembleResult != null ||
    (hasRounds && turn.rounds[0]?.streams?.length > 1)
  );
  const turnCostMeta = computeTurnCostMeta(turn);
  const turnCostLabel = formatCostWithQuality(turnCostMeta);

  const failedStreams = hasRounds
    ? turn.rounds.flatMap((round, roundIndex) =>
      (round.streams || [])
        .filter(stream => stream.status === 'error' || stream.error)
        .map((stream, streamIndex) => ({
          roundIndex,
          streamIndex,
          model: stream.model,
          error: stream.error || 'Unknown error',
        }))
    )
    : [];

  const formatError = (message) => {
    if (!message) return 'Unknown error';
    const lowered = message.toLowerCase();
    if (lowered.includes('aborted')) {
      return 'Request aborted — check provider model IDs, API keys, or server connectivity.';
    }
    return message;
  };

  return (
    <div className="debate-turn">
      <div className="user-message">
        <div className="user-message-body">
          <div className="user-message-header">
            <div className="user-message-actions">
              <CopyButton text={turn.userPrompt} />
              {isLastTurn && !debateInProgress && (
                <>
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
                </>
              )}
            </div>
            <span className="user-label">You</span>
            {turn.timestamp && (
              <span className="user-timestamp">{formatFullTimestamp(turn.timestamp)}</span>
            )}
          </div>
          <div className="user-text markdown-content">
            <MarkdownRenderer>{turn.userPrompt}</MarkdownRenderer>
          </div>
          {turn.attachments && turn.attachments.length > 0 && (
            <div className="user-attachments">
              {turn.attachments.map((att, i) => (
                <button
                  key={i}
                  className={`user-attachment-chip ${att.category}`}
                  onClick={() => setViewerAttachment(att)}
                  title="View attachment"
                >
                  {att.category === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}
                  <span className="user-attachment-name">{att.name}</span>
                  <span className="user-attachment-size">{formatFileSize(att.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="user-avatar">
          <User size={14} />
        </div>
      </div>

      {viewerAttachment && (
        <AttachmentViewer attachment={viewerAttachment} onClose={() => setViewerAttachment(null)} />
      )}

      {turn.webSearchResult && (
        <WebSearchPanel webSearchResult={turn.webSearchResult} />
      )}

      {failedStreams.length > 0 && (
        <div className="turn-error-panel glass-panel">
          <div className="turn-error-title">Some models failed</div>
          <div className="turn-error-list">
            {failedStreams.map((failure, idx) => (
              <div key={`${failure.model}-${idx}`} className="turn-error-item">
                <span className="turn-error-model">{getModelDisplayName(failure.model)}</span>
                <span className="turn-error-message">{formatError(failure.error)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {isDirectMode && hasRounds && isEnsembleTurn && (
        <>
          <EnsembleResultPanel ensembleResult={turn.ensembleResult} />

          <RoundSection
            round={turn.rounds[0]}
            isLatest
            roundIndex={0}
            isLastTurn={isLastTurn}
          />

          {turn.synthesis && turn.synthesis.status !== 'pending' && (
            <SynthesisView
              synthesis={turn.synthesis}
              debateMetadata={turn.debateMetadata}
              isLastTurn={isLastTurn}
              rounds={turn.rounds}
              ensembleResult={turn.ensembleResult}
            />
          )}

          {turn.synthesis?.status === 'complete' && turnCostLabel && (
            <div className="turn-cost-summary">
              Turn cost:{' '}
              <span
                className={`turn-cost-value ${turnCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                title={getCostQualityDescription(turnCostMeta.quality)}
              >
                {turnCostLabel}
              </span>
            </div>
          )}
        </>
      )}

      {isDirectMode && hasRounds && !isEnsembleTurn && (
        <>
          <div className="direct-response">
            {turn.rounds[0]?.streams[0] && (
              <ModelCard
                stream={turn.rounds[0].streams[0]}
                roundIndex={0}
                streamIndex={0}
                isLastTurn={isLastTurn}
                allowRetry
              />
            )}
          </div>
          {turn.rounds[0]?.streams[0]?.status === 'complete' && turnCostLabel && (
            <div className="turn-cost-summary">
              Turn cost:{' '}
              <span
                className={`turn-cost-value ${turnCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
                title={getCostQualityDescription(turnCostMeta.quality)}
              >
                {turnCostLabel}
              </span>
            </div>
          )}
        </>
      )}

      {!isDirectMode && hasRounds && (
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
                  allowRetry
                  allowRoundRetry={!isParallelMode}
                  allowStreamRetry
                />
              ))}
            </div>
          ) : (
            <DebateThread rounds={turn.rounds} isLastTurn={isLastTurn} allowRetry />
          )}
        </>
      )}

      {!isDirectMode && !isParallelMode && turn.synthesis && turn.synthesis.status !== 'pending' && (
        <SynthesisView synthesis={turn.synthesis} debateMetadata={turn.debateMetadata} isLastTurn={isLastTurn} rounds={turn.rounds} />
      )}

      {!isDirectMode && !isParallelMode && turn.synthesis?.status === 'complete' && turnCostLabel && (
        <div className="turn-cost-summary">
          Turn cost:{' '}
          <span
            className={`turn-cost-value ${turnCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
            title={getCostQualityDescription(turnCostMeta.quality)}
          >
            {turnCostLabel}
          </span>
        </div>
      )}
    </div>
  );
}
