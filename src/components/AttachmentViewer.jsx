import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { formatFileSize } from '../lib/formatFileSize';
import {
  MAX_INLINE_TEXT_PREVIEW_CHARS,
  PDF_PREVIEW_LOAD_TIMEOUT_MS,
  PDF_PREVIEW_RENDER_TIMEOUT_MS,
  getAttachmentPreviewFallbackMessage,
  getAttachmentPreviewModeLabel,
  getAttachmentPreviewPlan,
  getAttachmentTextPreview,
  getAttachmentTypeLabel,
} from '../lib/attachmentPreview';
import MarkdownRenderer from './MarkdownRenderer';
import './AttachmentViewer.css';

const MAX_INLINE_PDF_CANVAS_PAGES = 250;
let pdfjsPromise;

function isLikelyMarkdown(name) {
  return /\.mdx?$/i.test(name || '');
}

function withTimeout(promise, ms, message, onTimeout = null) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Ignore timeout cleanup failures and surface the original timeout.
      }
      reject(new Error(message));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      resolve();
      return;
    }

    window.requestAnimationFrame(() => resolve());
  });
}

function scheduleAfterPaint(callback) {
  if (typeof window === 'undefined') {
    const timeoutId = setTimeout(callback, 0);
    return () => clearTimeout(timeoutId);
  }

  let idleId = null;
  const rafId = window.requestAnimationFrame(() => {
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(callback, { timeout: 1_000 });
      return;
    }

    idleId = window.setTimeout(callback, 0);
  });

  return () => {
    window.cancelAnimationFrame(rafId);
    if (idleId === null) return;
    if (typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
      return;
    }
    window.clearTimeout(idleId);
  };
}

async function createObjectUrlFromDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to prepare PDF preview (${response.status}).`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjsLib, workerUrl]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.default || workerUrl;
      return pdfjsLib;
    });
  }

  return pdfjsPromise;
}

function formatAssetLoadError(error, fallback) {
  const message = String(error?.message || '');
  if (message.includes('(410)')) {
    return 'This generated file link has expired. Regenerate the artifact to view or download it again.';
  }
  if (message.includes('(403)')) {
    return 'This generated file link is no longer valid. Regenerate the artifact to continue.';
  }
  return fallback;
}

function buildDetailRows(attachment) {
  const rows = [
    { label: 'Type', value: getAttachmentTypeLabel(attachment) },
    attachment?.type ? { label: 'MIME', value: attachment.type } : null,
    attachment?.previewMeta?.pageCount > 0 ? { label: 'Pages', value: String(attachment.previewMeta.pageCount) } : null,
    attachment?.generatedFormat ? { label: 'Format', value: String(attachment.generatedFormat).toUpperCase() } : null,
    attachment?.generated ? { label: 'Source', value: 'Generated artifact' } : null,
    attachment?.processingStatus ? { label: 'Status', value: attachment.processingStatus } : null,
    attachment?.expiresAt ? { label: 'Expires', value: new Date(attachment.expiresAt).toLocaleString() } : null,
  ];

  return rows.filter(Boolean);
}

function PdfPageCanvas({
  pdfDoc,
  pageNumber,
  scale,
  onRenderError,
  estimatedPageSize = null,
}) {
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [isRendering, setIsRendering] = useState(true);
  const [pageSize, setPageSize] = useState(estimatedPageSize);

  useEffect(() => {
    setPageSize(estimatedPageSize);
  }, [estimatedPageSize]);

  useEffect(() => {
    let cancelled = false;
    let page = null;

    if (!pdfDoc || !canvasRef.current) return undefined;

    setIsRendering(true);

    (async () => {
      try {
        page = await withTimeout(
          pdfDoc.getPage(pageNumber),
          PDF_PREVIEW_LOAD_TIMEOUT_MS,
          `PDF page ${pageNumber} took too long to load.`
        );
        if (cancelled) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!context) {
          throw new Error('Canvas rendering is unavailable in this browser.');
        }

        const pixelRatio = typeof window !== 'undefined'
          ? Math.min(window.devicePixelRatio || 1, 1.5)
          : 1;

        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        setPageSize({ width: viewport.width, height: viewport.height });

        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);

        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }

        const renderTask = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = renderTask;
        await withTimeout(
          renderTask.promise,
          PDF_PREVIEW_RENDER_TIMEOUT_MS,
          `PDF page ${pageNumber} took too long to render.`,
          () => renderTask.cancel()
        );

        if (!cancelled) {
          setIsRendering(false);
        }
        renderTaskRef.current = null;
        page.cleanup?.();
      } catch (error) {
        if (cancelled || error?.name === 'RenderingCancelledException') return;
        setIsRendering(false);
        onRenderError?.(error);
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      page?.cleanup?.();
    };
  }, [onRenderError, pageNumber, pdfDoc, scale]);

  const fallbackWidth = Math.max(280, Math.round(
    pageSize?.width || ((estimatedPageSize?.width || 612) * scale)
  ));
  const fallbackHeight = Math.max(360, Math.round(
    pageSize?.height || ((estimatedPageSize?.height || 792) * scale)
  ));

  return (
    <div
      className={`attachment-viewer-pdf-canvas${isRendering ? ' is-rendering' : ''}`}
      style={{
        '--pdf-page-width': `${fallbackWidth}px`,
        '--pdf-page-height': `${fallbackHeight}px`,
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}

export default function AttachmentViewer({ attachment, onClose }) {
  const [textObjectUrl, setTextObjectUrl] = useState(null);
  const [pdfObjectUrl, setPdfObjectUrl] = useState(null);
  const [preparingPdfSource, setPreparingPdfSource] = useState(false);
  const [previewMode, setPreviewMode] = useState('details');
  const [previewNotice, setPreviewNotice] = useState('');
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [pdfPageSize, setPdfPageSize] = useState(null);
  const pdfLoadIdRef = useRef(0);

  const previewPlan = useMemo(() => getAttachmentPreviewPlan(attachment), [attachment]);
  const detailRows = useMemo(() => buildDetailRows(attachment), [attachment]);
  const isMarkdown = useMemo(() => isLikelyMarkdown(attachment?.name), [attachment?.name]);
  const previewModes = previewPlan.modes || ['details'];
  const hasLocalPdfDataUrl = previewPlan.kind === 'pdf'
    && !attachment?.downloadUrl
    && String(attachment?.dataUrl || '').startsWith('data:application/pdf;');
  const pdfSourceUrl = attachment?.downloadUrl || pdfObjectUrl || null;
  const sourceUrl = previewPlan.kind === 'pdf'
    ? pdfSourceUrl
    : (attachment?.downloadUrl || attachment?.dataUrl || textObjectUrl || null);
  const downloadUrl = attachment?.downloadUrl || attachment?.dataUrl || pdfObjectUrl || textObjectUrl || null;
  const canDownload = Boolean(downloadUrl);
  const pdfSourcePending = previewPlan.kind === 'pdf' && previewMode === 'pdfjs' && !pdfSourceUrl && hasLocalPdfDataUrl;
  const textPreview = useMemo(
    () => getAttachmentTextPreview(attachment?.content, MAX_INLINE_TEXT_PREVIEW_CHARS),
    [attachment?.content]
  );

  const resetPdfState = useCallback(() => {
    setPdfDoc(null);
    setPdfPages(0);
    setPdfPage(1);
    setPdfScale(1);
    setPdfPageSize(null);
    setPdfLoading(false);
  }, []);

  const switchPreviewMode = useCallback((mode, clearNotice = true) => {
    setPreviewMode(mode);
    if (clearNotice) {
      setPreviewNotice('');
    }
  }, []);

  const handlePdfFallback = useCallback((message) => {
    setPreviewNotice(message);
    setPreviewMode((current) => (
      current === 'pdfjs'
        ? (previewPlan.pdfFallbackMode || 'details')
        : current
    ));
  }, [previewPlan.pdfFallbackMode]);

  const handlePdfRenderError = useCallback((error) => {
    handlePdfFallback(formatAssetLoadError(error, 'Unable to render PDF preview.'));
  }, [handlePdfFallback]);

  const renderDetails = useCallback((message = null) => (
    <div className="attachment-viewer-details">
      <div className="attachment-viewer-message">
        {message || getAttachmentPreviewFallbackMessage(attachment, previewPlan)}
      </div>
      <dl className="attachment-viewer-details-grid">
        {detailRows.map((row) => (
          <div key={row.label} className="attachment-viewer-details-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  ), [attachment, detailRows, previewPlan]);

  const renderTextDocument = useCallback((markdown = false) => {
    if (!textPreview.text) {
      return renderDetails('No extracted text preview is available for this file.');
    }

    const truncationLabel = textPreview.truncated
      ? `Showing the first ${textPreview.shownChars.toLocaleString()} of ${textPreview.totalChars.toLocaleString()} characters for a stable preview.`
      : '';

    return (
      <div className="attachment-viewer-document">
        {truncationLabel && (
          <div className="attachment-viewer-text-banner">{truncationLabel}</div>
        )}
        <div className="attachment-viewer-document-scroll attachment-viewer-text">
          {markdown ? <MarkdownRenderer>{textPreview.text}</MarkdownRenderer> : <pre>{textPreview.text}</pre>}
        </div>
      </div>
    );
  }, [renderDetails, textPreview]);

  useEffect(() => {
    if (!attachment) return undefined;
    if (!attachment.dataUrl && attachment.content && attachment.category === 'text') {
      const blob = new Blob([attachment.content], { type: attachment.type || 'text/plain' });
      const url = URL.createObjectURL(blob);
      setTextObjectUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setTextObjectUrl(null);
    return undefined;
  }, [attachment]);

  useEffect(() => {
    if (!hasLocalPdfDataUrl) {
      setPdfObjectUrl(null);
      setPreparingPdfSource(false);
      return undefined;
    }

    let cancelled = false;
    let nextUrl = null;
    setPdfObjectUrl(null);
    setPreparingPdfSource(true);

    (async () => {
      try {
        nextUrl = await createObjectUrlFromDataUrl(attachment.dataUrl);
        if (cancelled) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        setPdfObjectUrl(nextUrl);
      } catch {
        if (!cancelled) {
          setPdfObjectUrl(null);
        }
      } finally {
        if (!cancelled) {
          setPreparingPdfSource(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (nextUrl) {
        URL.revokeObjectURL(nextUrl);
      }
    };
  }, [attachment?.dataUrl, hasLocalPdfDataUrl]);

  useEffect(() => {
    if (previewPlan.kind !== 'pdf' || !previewModes.includes('pdfjs')) {
      return undefined;
    }

    return scheduleAfterPaint(() => {
      void loadPdfjs().catch(() => {});
    });
  }, [previewModes, previewPlan.kind]);

  useEffect(() => {
    if (previewPlan.kind !== 'pdf' || previewMode !== 'pdfjs' || !hasLocalPdfDataUrl) {
      return undefined;
    }

    if (preparingPdfSource || pdfSourceUrl) {
      return undefined;
    }

    handlePdfFallback('Unable to prepare a stable local PDF preview.');
    return undefined;
  }, [
    handlePdfFallback,
    hasLocalPdfDataUrl,
    pdfSourceUrl,
    preparingPdfSource,
    previewMode,
    previewPlan.kind,
  ]);

  useEffect(() => {
    setPreviewMode(previewPlan.initialMode || 'details');
    setPreviewNotice('');
    setImageError('');
    setMediaError('');
  }, [
    attachment?.name,
    attachment?.downloadUrl,
    attachment?.dataUrl,
    attachment?.content,
    attachment?.type,
    attachment?.category,
    attachment?.processingStatus,
    attachment?.error,
    previewPlan.initialMode,
  ]);

  useEffect(() => {
    if (!attachment) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [attachment, onClose]);

  useEffect(() => {
    let cancelled = false;
    let activeDoc = null;
    let loadingTask = null;
    const currentLoadId = pdfLoadIdRef.current + 1;
    pdfLoadIdRef.current = currentLoadId;

    if (
      !attachment ||
      previewPlan.kind !== 'pdf' ||
      previewMode !== 'pdfjs' ||
      !pdfSourceUrl
    ) {
      resetPdfState();
      return undefined;
    }

    setPdfLoading(true);
    setPdfDoc(null);
    setPdfPages(0);
    setPdfPage(1);
    setPdfScale(1);
    setPdfPageSize(null);

    (async () => {
      try {
        await waitForNextPaint();
        const pdfjsLib = await loadPdfjs();
        loadingTask = pdfjsLib.getDocument(pdfSourceUrl);
        const doc = await withTimeout(
          loadingTask.promise,
          PDF_PREVIEW_LOAD_TIMEOUT_MS,
          'PDF preview took too long to load.',
          () => loadingTask?.destroy?.()
        );
        activeDoc = doc;

        if (cancelled || pdfLoadIdRef.current !== currentLoadId) {
          Promise.resolve(doc.destroy()).catch(() => {});
          return;
        }

        if ((doc.numPages || 0) > MAX_INLINE_PDF_CANVAS_PAGES) {
          setPdfLoading(false);
          setPreviewNotice(
            `This PDF has ${doc.numPages} pages. Switched to a safer preview mode to avoid freezing the inline renderer.`
          );
          setPreviewMode((current) => (
            current === 'pdfjs'
              ? (previewPlan.modes.includes('browser') ? 'browser' : (previewPlan.pdfFallbackMode || 'details'))
              : current
          ));
          return;
        }

        setPdfDoc(doc);
        setPdfPages(doc.numPages || 0);
        setPdfPage(1);
        setPdfScale(1);
        setPdfPageSize(null);
        setPdfLoading(false);
      } catch (error) {
        if (cancelled) return;
        resetPdfState();
        handlePdfFallback(formatAssetLoadError(error, 'Unable to load PDF preview.'));
      }
    })();

    return () => {
      cancelled = true;
      if (activeDoc) {
        Promise.resolve(activeDoc.destroy()).catch(() => {});
      } else if (loadingTask?.destroy) {
        Promise.resolve(loadingTask.destroy()).catch(() => {});
      }
    };
  }, [
    attachment,
    handlePdfFallback,
    previewMode,
    previewPlan.kind,
    previewPlan.modes,
    previewPlan.pdfFallbackMode,
    pdfSourceUrl,
    resetPdfState,
  ]);

  useEffect(() => () => {
    if (pdfDoc) {
      Promise.resolve(pdfDoc.destroy()).catch(() => {});
    }
  }, [pdfDoc]);

  if (!attachment) return null;

  const renderBody = () => {
    if (previewMode === 'image') {
      if (!sourceUrl) {
        return renderDetails('Image source is unavailable. Reattach the file to preview it again.');
      }
      if (imageError) {
        return renderDetails(imageError);
      }
      return (
        <div className="attachment-viewer-media">
          <img
            className="attachment-viewer-image"
            src={sourceUrl}
            alt={attachment.name}
            onError={() => {
              const message = 'Unable to preview image. The generated file link may have expired.';
              setImageError(message);
              setPreviewNotice(message);
            }}
          />
        </div>
      );
    }

    if (previewMode === 'video') {
      if (!sourceUrl) {
        return renderDetails('Video source is unavailable. Reattach the file to preview it again.');
      }
      if (mediaError) {
        return renderDetails(mediaError);
      }
      return (
        <div className="attachment-viewer-media">
          <video
            className="attachment-viewer-video"
            src={sourceUrl}
            controls
            preload="metadata"
            onError={() => {
              const message = 'Unable to preview this video inline.';
              setMediaError(message);
              setPreviewNotice(message);
              setPreviewMode(previewPlan.fallbackMode || 'details');
            }}
          />
        </div>
      );
    }

    if (previewMode === 'audio') {
      if (!sourceUrl) {
        return renderDetails('Audio source is unavailable. Reattach the file to preview it again.');
      }
      if (mediaError) {
        return renderDetails(mediaError);
      }
      return (
        <div className="attachment-viewer-media">
          <audio
            className="attachment-viewer-audio"
            src={sourceUrl}
            controls
            preload="metadata"
            onError={() => {
              const message = 'Unable to preview this audio file inline.';
              setMediaError(message);
              setPreviewNotice(message);
              setPreviewMode(previewPlan.fallbackMode || 'details');
            }}
          />
        </div>
      );
    }

    if (previewMode === 'browser') {
      if (!sourceUrl) {
        return renderDetails();
      }
      return (
        <div className="attachment-viewer-media">
          <iframe
            className="attachment-viewer-iframe"
            src={sourceUrl}
            title={attachment.name || 'attachment'}
          />
        </div>
      );
    }

    if (previewMode === 'pdfjs') {
      if (!sourceUrl) {
        if (pdfSourcePending || preparingPdfSource) {
          return (
            <div className="attachment-viewer-pdf">
              <div className="attachment-viewer-pdf-controls">
                <button type="button" disabled>Prev</button>
                <span>Page - / -</span>
                <button type="button" disabled>Next</button>
                <div className="attachment-viewer-pdf-spacer" />
                <button type="button" disabled>-</button>
                <span>100%</span>
                <button type="button" disabled>+</button>
                <button type="button" disabled>Reset</button>
              </div>
              <div className="attachment-viewer-pdf-stage">
                <div className="attachment-viewer-message">Preparing PDF preview...</div>
              </div>
            </div>
          );
        }

        return textPreview.text
          ? renderTextDocument(false)
          : renderDetails();
      }

      return (
        <div className="attachment-viewer-pdf">
          <div className="attachment-viewer-pdf-controls">
            <button
              type="button"
              onClick={() => setPdfPage((current) => Math.max(1, current - 1))}
              disabled={pdfPage <= 1 || pdfLoading || pdfSourcePending}
            >
              Prev
            </button>
            <span>Page {pdfPage} / {pdfPages || '-'}</span>
            <button
              type="button"
              onClick={() => setPdfPage((current) => Math.min(pdfPages || current, current + 1))}
              disabled={pdfPages === 0 || pdfPage >= pdfPages || pdfLoading || pdfSourcePending}
            >
              Next
            </button>
            <div className="attachment-viewer-pdf-spacer" />
            <button
              type="button"
              onClick={() => setPdfScale((scale) => Math.max(0.5, Number((scale - 0.1).toFixed(2))))}
              disabled={pdfLoading || pdfSourcePending}
            >
              -
            </button>
            <span>{Math.round(pdfScale * 100)}%</span>
            <button
              type="button"
              onClick={() => setPdfScale((scale) => Math.min(3, Number((scale + 0.1).toFixed(2))))}
              disabled={pdfLoading || pdfSourcePending}
            >
              +
            </button>
            <button type="button" onClick={() => setPdfScale(1)} disabled={pdfLoading || pdfSourcePending}>Reset</button>
          </div>
          <div className="attachment-viewer-pdf-stage">
            {(pdfLoading || pdfSourcePending) && <div className="attachment-viewer-message">Loading PDF...</div>}
            {!pdfLoading && !pdfSourcePending && pdfPages === 0 && (
              <div className="attachment-viewer-message">No PDF pages are available for preview.</div>
            )}
            {!pdfLoading && !pdfSourcePending && pdfPages > 0 && (
              <>
                <div className="attachment-viewer-pdf-page-label">Page {pdfPage}</div>
                <PdfPageCanvas
                  pdfDoc={pdfDoc}
                  pageNumber={pdfPage}
                  scale={pdfScale}
                  onRenderError={handlePdfRenderError}
                  estimatedPageSize={pdfPageSize}
                />
              </>
            )}
          </div>
        </div>
      );
    }

    if (previewMode === 'text') {
      return renderTextDocument(isMarkdown);
    }

    return renderDetails();
  };

  return (
    <div className="attachment-viewer-overlay" onClick={onClose}>
      <div className="attachment-viewer-modal" onClick={(event) => event.stopPropagation()}>
        <div className="attachment-viewer-header">
          <div className="attachment-viewer-meta">
            <div className="attachment-viewer-name">{attachment.name}</div>
            <div className="attachment-viewer-size">{formatFileSize(attachment.size)}</div>
          </div>
          <div className="attachment-viewer-actions">
            {canDownload && (
              <a className="attachment-viewer-download" href={downloadUrl} download={attachment.name}>
                <Download size={14} />
                <span>Download</span>
              </a>
            )}
            <button className="attachment-viewer-close" onClick={onClose} title="Close" type="button">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="attachment-viewer-body">
          {previewModes.length > 1 && (
            <div className="attachment-viewer-modebar" role="tablist" aria-label="Attachment preview mode">
              {previewModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={previewMode === mode}
                  className={`attachment-viewer-modebutton${previewMode === mode ? ' active' : ''}`}
                  onClick={() => switchPreviewMode(mode)}
                >
                  {getAttachmentPreviewModeLabel(mode)}
                </button>
              ))}
            </div>
          )}
          {previewNotice && (
            <div className="attachment-viewer-alert">{previewNotice}</div>
          )}
          {renderBody()}
        </div>
      </div>
    </div>
  );
}
