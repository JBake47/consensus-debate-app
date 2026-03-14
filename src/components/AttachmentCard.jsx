import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Plus,
  X,
} from 'lucide-react';
import { formatFileSize } from '../lib/formatFileSize';
import { getModelDisplayName } from '../lib/openrouter';
import './AttachmentCard.css';

function getCategoryIcon(category) {
  switch (String(category || '').toLowerCase()) {
    case 'image':
      return <ImageIcon size={16} />;
    case 'excel':
      return <FileSpreadsheet size={16} />;
    default:
      return <FileText size={16} />;
  }
}

function getCategoryLabel(category) {
  switch (String(category || '').toLowerCase()) {
    case 'image':
      return 'Image';
    case 'pdf':
      return 'PDF';
    case 'word':
      return 'DOCX';
    case 'excel':
      return 'Spreadsheet';
    case 'binary':
      return 'File';
    default:
      return 'Text';
  }
}

function formatPreviewMeta(attachment, imageMeta) {
  const meta = attachment?.previewMeta || {};
  const category = String(attachment?.category || '').toLowerCase();
  if (category === 'image') {
    const width = imageMeta?.width || meta?.width || 0;
    const height = imageMeta?.height || meta?.height || 0;
    if (width > 0 && height > 0) {
      return `${width} x ${height}`;
    }
    return 'Image preview';
  }
  if (category === 'pdf' && meta?.pageCount > 0) {
    return `${meta.pageCount} page${meta.pageCount === 1 ? '' : 's'}`;
  }
  if (meta?.lineCount > 0) {
    return `${meta.lineCount} line${meta.lineCount === 1 ? '' : 's'}`;
  }
  if (meta?.charCount > 0) {
    return `${meta.charCount.toLocaleString()} chars`;
  }
  return '';
}

function renderModelNames(modelIds) {
  return modelIds.map((modelId) => getModelDisplayName(modelId)).join(', ');
}

function buildDocumentPreviewLines(attachment) {
  const baseText = String(attachment?.content || '')
    .slice(0, 4000)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const category = String(attachment?.category || '').toLowerCase();

  if (category === 'excel') {
    const rows = baseText
      .slice(0, 4)
      .map((line) => line.split(',').map((cell) => cell.trim()).filter(Boolean).slice(0, 4).join('   '));
    if (rows.length > 0) return rows;
  }

  if (baseText.length > 0) {
    return baseText.slice(0, 5).map((line) => line.slice(0, 42));
  }

  const fallbackName = String(attachment?.name || 'attachment')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  return [
    fallbackName || 'Attachment preview',
    `${getCategoryLabel(category)} file`,
    'Click to expand',
  ];
}

function buildRoutingTooltip(routing) {
  if (!routing) return '';
  const lines = [];
  if (routing.primaryLabel) {
    lines.push(`Routing: ${routing.primaryLabel}`);
  }
  if (routing.nativeModels?.length > 0) {
    lines.push(`Native: ${renderModelNames(routing.nativeModels)}`);
  }
  if (routing.fallbackModels?.length > 0) {
    lines.push(`Fallback: ${renderModelNames(routing.fallbackModels)}`);
  }
  if (routing.excludedModels?.length > 0) {
    lines.push(`Excluded: ${renderModelNames(routing.excludedModels)}`);
    const firstReason = routing.reasonsByModel?.[routing.excludedModels[0]];
    if (firstReason) {
      lines.push(firstReason);
    }
  }
  return lines.join('\n');
}

function getWarningText(attachment, routing) {
  if (attachment?.error) return attachment.error;
  if (attachment?.inlineWarning) return attachment.inlineWarning;
  if (routing?.excludedModels?.length > 0 && routing?.nativeModels?.length === 0 && routing?.fallbackModels?.length === 0) {
    return routing?.reasonsByModel?.[routing.excludedModels[0]] || 'This attachment will not be sent.';
  }
  return '';
}

function getSecondaryLabel(attachment, previewMeta, routing, showTransport) {
  const metaParts = [previewMeta, formatFileSize(Number(attachment?.size || 0))].filter(Boolean);
  const metaLabel = metaParts.join(' - ');

  if (attachment?.processingStatus === 'processing') {
    return 'Preparing preview';
  }
  if (attachment?.processingStatus === 'error' || attachment?.category === 'error') {
    return 'Preview unavailable';
  }
  if (!showTransport || !routing) {
    return metaLabel || getCategoryLabel(attachment?.category);
  }
  if (routing.primaryTone === 'excluded') {
    return 'Not sent';
  }
  if (routing.primaryTone === 'fallback') {
    return metaLabel ? `Text fallback - ${metaLabel}` : 'Text fallback';
  }
  if (routing.primaryTone === 'mixed') {
    return metaLabel ? `Mixed routing - ${metaLabel}` : 'Mixed routing';
  }
  return metaLabel || routing.primaryLabel || getCategoryLabel(attachment?.category);
}

export default function AttachmentCard({
  attachment,
  routing = null,
  onPreview = null,
  onRemove = null,
  onReuse = null,
  disabled = false,
  showTransport = true,
  compact = false,
}) {
  const [imageMeta, setImageMeta] = useState(null);
  const imageSrc = attachment?.dataUrl || attachment?.downloadUrl || '';
  const canPreview = Boolean(onPreview) && attachment?.processingStatus !== 'processing' && !disabled;
  const canReuse = Boolean(onReuse) && !disabled;
  const previewMeta = useMemo(() => formatPreviewMeta(attachment, imageMeta), [attachment, imageMeta]);
  const documentPreviewLines = useMemo(() => buildDocumentPreviewLines(attachment), [attachment]);
  const warningText = useMemo(() => getWarningText(attachment, routing), [attachment, routing]);
  const secondaryLabel = useMemo(
    () => getSecondaryLabel(attachment, previewMeta, routing, showTransport),
    [attachment, previewMeta, routing, showTransport]
  );
  const tooltip = useMemo(
    () => [
      attachment?.name || 'attachment',
      secondaryLabel,
      warningText,
      buildRoutingTooltip(showTransport ? routing : null),
    ].filter(Boolean).join('\n'),
    [attachment?.name, routing, secondaryLabel, showTransport, warningText]
  );

  useEffect(() => {
    if (String(attachment?.category || '').toLowerCase() !== 'image' || !imageSrc) {
      setImageMeta(null);
      return undefined;
    }

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setImageMeta({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      if (cancelled) return;
      setImageMeta(null);
    };
    img.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [attachment?.category, imageSrc]);

  const handlePreview = () => {
    if (canPreview) {
      onPreview();
    }
  };

  const handleKeyDown = (event) => {
    if (!canPreview) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPreview();
    }
  };

  const handleActionClick = (event, action) => {
    event.stopPropagation();
    action?.();
  };

  const category = String(attachment?.category || 'text').toLowerCase();

  return (
    <div
      className={`attachment-card ${category} ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''} ${canPreview ? 'clickable' : ''}`}
      onClick={handlePreview}
      onKeyDown={handleKeyDown}
      role={canPreview ? 'button' : undefined}
      tabIndex={canPreview ? 0 : undefined}
      title={tooltip || undefined}
    >
      <div className="attachment-card-preview">
        {attachment?.processingStatus === 'processing' ? (
          <div className="attachment-card-preview-placeholder processing">
            <Loader2 size={20} className="spinning" />
          </div>
        ) : attachment?.processingStatus === 'error' || attachment?.category === 'error' ? (
          <div className="attachment-card-preview-placeholder error">
            <AlertCircle size={20} />
          </div>
        ) : category === 'image' && imageSrc ? (
          <img src={imageSrc} alt={attachment?.name || 'attachment'} className="attachment-card-image" />
        ) : category === 'binary' ? (
          <div className="attachment-card-preview-placeholder">
            {getCategoryIcon(attachment?.category)}
          </div>
        ) : (
          <div className={`attachment-card-document-preview ${category}`}>
            <div className="attachment-card-document-sheet">
              <div className="attachment-card-document-header">
                <span className="attachment-card-document-label">{getCategoryLabel(category)}</span>
                {getCategoryIcon(category)}
              </div>
              <div className="attachment-card-document-lines">
                {documentPreviewLines.map((line, index) => (
                  <div key={`${attachment?.name || 'attachment'}-${index}`} className="attachment-card-document-line">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="attachment-card-overlay">
          <div className="attachment-card-topbar">
            {canPreview ? (
              <span className="attachment-card-expand-hint">
                <Maximize2 size={12} />
                <span>Expand</span>
              </span>
            ) : (
              <span />
            )}
            <div className="attachment-card-actions">
              {canReuse && (
                <button
                  type="button"
                  className="attachment-card-action"
                  onClick={(event) => handleActionClick(event, onReuse)}
                  title="Add attachment"
                >
                  <Plus size={14} />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="attachment-card-action danger"
                  onClick={(event) => handleActionClick(event, onRemove)}
                  title="Remove attachment"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {showTransport && routing?.primaryLabel && (
            <div className="attachment-card-status-wrap">
              <span className={`attachment-card-status ${routing.primaryTone || 'neutral'}`}>
                {routing.primaryLabel}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="attachment-card-footer">
        <div className="attachment-card-name" title={attachment?.name || 'attachment'}>
          {attachment?.name || 'attachment'}
        </div>
        <div className={`attachment-card-caption ${warningText ? 'warning' : ''}`}>
          {warningText || secondaryLabel}
        </div>
      </div>
    </div>
  );
}
