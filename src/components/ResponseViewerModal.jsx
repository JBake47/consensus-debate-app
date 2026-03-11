import { useEffect } from 'react';
import { X, Maximize2, Loader2 } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import CopyButton from './CopyButton';
import './ResponseViewerModal.css';

export default function ResponseViewerModal({
  open,
  onClose,
  title = 'Expanded response',
  subtitle = '',
  content = '',
  status = 'complete',
  children = null,
}) {
  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  if (children) {
    return (
      <div className="response-viewer-overlay" onClick={onClose}>
        <div
          className="response-viewer-panel-shell"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <button
            className="response-viewer-floating-close"
            onClick={onClose}
            aria-label="Close expanded panel"
            type="button"
          >
            <X size={18} />
          </button>
          <div className="response-viewer-panel-content">
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="response-viewer-overlay" onClick={onClose}>
      <div
        className={`response-viewer-modal glass-panel ${status}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="response-viewer-header">
          <div className="response-viewer-meta">
            <div className="response-viewer-title-row">
              <Maximize2 size={14} />
              <span className="response-viewer-title">{title}</span>
              {status === 'streaming' && (
                <span className="response-viewer-status">
                  <Loader2 size={12} className="spinning" />
                  Streaming
                </span>
              )}
            </div>
            {subtitle && <div className="response-viewer-subtitle">{subtitle}</div>}
          </div>
          <div className="response-viewer-actions">
            {content && <CopyButton text={content} className="response-viewer-copy" />}
            <button
              className="response-viewer-close"
              onClick={onClose}
              aria-label="Close expanded response"
              type="button"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="response-viewer-body">
          {content ? (
            <div className="markdown-content">
              <MarkdownRenderer>{content}</MarkdownRenderer>
              {status === 'streaming' && <span className="cursor-blink" />}
            </div>
          ) : (
            <div className="response-viewer-empty">No response text available.</div>
          )}
        </div>
      </div>
    </div>
  );
}
