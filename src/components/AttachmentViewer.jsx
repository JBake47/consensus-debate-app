import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { formatFileSize } from '../lib/formatFileSize';
import {
  PDF_PREVIEW_LOAD_TIMEOUT_MS,
  PDF_PREVIEW_RENDER_TIMEOUT_MS,
  getAttachmentPreviewFallbackMessage,
  getAttachmentPreviewModeLabel,
  getAttachmentPreviewPlan,
  getAttachmentTypeLabel,
} from '../lib/attachmentPreview';
import MarkdownRenderer from './MarkdownRenderer';
import './AttachmentViewer.css';

const MAX_INLINE_PDF_CANVAS_PAGES = 60;

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
  scrollRootRef,
  eager = false,
  estimatedPageSize = null,
}) {
  const pageRef = useRef(null);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [shouldRender, setShouldRender] = useState(eager);
  const [isRendering, setIsRendering] = useState(eager);
  const [pageSize, setPageSize] = useState(estimatedPageSize);

  useEffect(() => {
    setPageSize(estimatedPageSize);
  }, [estimatedPageSize]);

  useEffect(() => {
    if (eager) {
      setShouldRender(true);
    }
  }, [eager]);

  useEffect(() => {
    if (shouldRender) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      setShouldRender(true);
      return undefined;
    }

    const pageElement = pageRef.current;
    const scrollRoot = scrollRootRef?.current;
    if (!pageElement || !scrollRoot) {
      setShouldRender(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldRender(true);
        observer.disconnect();
      },
      {
        root: scrollRoot,
        rootMargin: '900px 0px',
        threshold: 0.01,
      }
    );

    observer.observe(pageElement);
    return () => observer.disconnect();
  }, [scrollRootRef, shouldRender]);

  useEffect(() => {
    let cancelled = false;
    let page = null;

    if (!pdfDoc || !canvasRef.current || !shouldRender) return undefined;

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
  }, [onRenderError, pageNumber, pdfDoc, scale, shouldRender]);

  const fallbackWidth = Math.max(280, Math.round(
    pageSize?.width || ((estimatedPageSize?.width || 612) * scale)
  ));
  const fallbackHeight = Math.max(360, Math.round(
    pageSize?.height || ((estimatedPageSize?.height || 792) * scale)
  ));

  return (
    <div
      ref={pageRef}
      className={`attachment-viewer-pdf-canvas${isRendering ? ' is-rendering' : ''}`}
      style={{
        '--pdf-page-width': `${fallbackWidth}px`,
        '--pdf-page-height': `${fallbackHeight}px`,
      }}
    >
      {!shouldRender && (
        <div className="attachment-viewer-pdf-placeholder">
          <span>Page {pageNumber}</span>
        </div>
      )}
      {shouldRender && <canvas ref={canvasRef} />}
    </div>
  );
}

export default function AttachmentViewer({ attachment, onClose }) {
  const [objectUrl, setObjectUrl] = useState(null);
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
  const pdfScrollRef = useRef(null);

  const previewPlan = useMemo(() => getAttachmentPreviewPlan(attachment), [attachment]);
  const detailRows = useMemo(() => buildDetailRows(attachment), [attachment]);
  const isMarkdown = useMemo(() => isLikelyMarkdown(attachment?.name), [attachment?.name]);
  const sourceUrl = attachment?.downloadUrl || attachment?.dataUrl || objectUrl || null;
  const canDownload = Boolean(sourceUrl);
  const previewModes = previewPlan.modes || ['details'];
  const pdfPageNumbers = useMemo(
    () => Array.from({ length: Math.max(0, pdfPages) }, (_, index) => index + 1),
    [pdfPages]
  );

  const loadPdfjs = useMemo(() => {
    let pdfjsPromise;
    return async () => {
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
    };
  }, []);

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

  const renderTextDocument = useCallback((content, markdown = false) => (
    <div className="attachment-viewer-document">
      <div className="attachment-viewer-document-scroll attachment-viewer-text">
        {markdown ? <MarkdownRenderer>{content}</MarkdownRenderer> : <pre>{content}</pre>}
      </div>
    </div>
  ), []);

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

  const scrollToPdfPage = useCallback((targetPage) => {
    const boundedPage = Math.max(1, Math.min(pdfPages || targetPage, targetPage));
    const pageElement = pdfScrollRef.current?.querySelector(`[data-pdf-page="${boundedPage}"]`);
    if (!pageElement) {
      setPdfPage(boundedPage);
      return;
    }
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPdfPage(boundedPage);
  }, [pdfPages]);

  useEffect(() => {
    if (!attachment) return undefined;
    if (!attachment.dataUrl && attachment.content && attachment.category === 'text') {
      const blob = new Blob([attachment.content], { type: attachment.type || 'text/plain' });
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setObjectUrl(null);
    return undefined;
  }, [attachment]);

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
      !sourceUrl
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
        const pdfjsLib = await loadPdfjs();
        loadingTask = pdfjsLib.getDocument(sourceUrl);
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

        const firstPage = await withTimeout(
          doc.getPage(1),
          PDF_PREVIEW_LOAD_TIMEOUT_MS,
          'PDF preview took too long to prepare.'
        );
        const firstViewport = firstPage.getViewport({ scale: 1 });
        firstPage.cleanup?.();

        setPdfDoc(doc);
        setPdfPages(doc.numPages || 0);
        setPdfPage(1);
        setPdfScale(1);
        setPdfPageSize({
          width: firstViewport.width,
          height: firstViewport.height,
        });
        if (pdfScrollRef.current) {
          pdfScrollRef.current.scrollTop = 0;
        }
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
    loadPdfjs,
    previewMode,
    previewPlan.kind,
    previewPlan.modes,
    previewPlan.pdfFallbackMode,
    resetPdfState,
    sourceUrl,
  ]);

  useEffect(() => () => {
    if (pdfDoc) {
      Promise.resolve(pdfDoc.destroy()).catch(() => {});
    }
  }, [pdfDoc]);

  useEffect(() => {
    const container = pdfScrollRef.current;
    if (
      previewMode !== 'pdfjs' ||
      typeof IntersectionObserver !== 'function' ||
      !container ||
      pdfPageNumbers.length === 0
    ) {
      return undefined;
    }

    const pageElements = Array.from(container.querySelectorAll('[data-pdf-page]'));
    if (pageElements.length === 0) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];

        if (!visibleEntry) return;
        const nextPage = Number(visibleEntry.target.getAttribute('data-pdf-page')) || 1;
        setPdfPage((current) => (current === nextPage ? current : nextPage));
      },
      {
        root: container,
        threshold: [0.25, 0.5, 0.75],
      }
    );

    pageElements.forEach((element) => observer.observe(element));

    return () => {
      observer.disconnect();
    };
  }, [pdfPageNumbers, pdfScale, previewMode]);

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
        return attachment.content
          ? renderTextDocument(attachment.content)
          : renderDetails();
      }

      return (
        <div className="attachment-viewer-pdf">
          <div className="attachment-viewer-pdf-controls">
            <button
              type="button"
              onClick={() => scrollToPdfPage(pdfPage - 1)}
              disabled={pdfPage <= 1 || pdfLoading}
            >
              Prev
            </button>
            <span>Page {pdfPage} / {pdfPages || '-'}</span>
            <button
              type="button"
              onClick={() => scrollToPdfPage(pdfPage + 1)}
              disabled={pdfPages === 0 || pdfPage >= pdfPages || pdfLoading}
            >
              Next
            </button>
            <span className="attachment-viewer-pdf-hint">Scroll to browse pages</span>
            <div className="attachment-viewer-pdf-spacer" />
            <button
              type="button"
              onClick={() => setPdfScale((scale) => Math.max(0.5, Number((scale - 0.1).toFixed(2))))}
              disabled={pdfLoading}
            >
              -
            </button>
            <span>{Math.round(pdfScale * 100)}%</span>
            <button
              type="button"
              onClick={() => setPdfScale((scale) => Math.min(3, Number((scale + 0.1).toFixed(2))))}
              disabled={pdfLoading}
            >
              +
            </button>
            <button type="button" onClick={() => setPdfScale(1)} disabled={pdfLoading}>Reset</button>
          </div>
          <div className="attachment-viewer-pdf-pages" ref={pdfScrollRef}>
            {pdfLoading && <div className="attachment-viewer-message">Loading PDF...</div>}
            {!pdfLoading && pdfPageNumbers.length === 0 && (
              <div className="attachment-viewer-message">No PDF pages are available for preview.</div>
            )}
            {!pdfLoading && pdfPageNumbers.map((pageNumber) => (
              <div
                key={`${attachment.name || 'pdf'}-${pageNumber}-${pdfScale}`}
                className="attachment-viewer-pdf-page"
                data-pdf-page={pageNumber}
              >
                <div className="attachment-viewer-pdf-page-label">Page {pageNumber}</div>
                <PdfPageCanvas
                  pdfDoc={pdfDoc}
                  pageNumber={pageNumber}
                  scale={pdfScale}
                  onRenderError={handlePdfRenderError}
                  scrollRootRef={pdfScrollRef}
                  eager={pageNumber <= 2}
                  estimatedPageSize={pdfPageSize}
                />
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (previewMode === 'text') {
      if (!attachment.content) {
        return renderDetails('No extracted text preview is available for this file.');
      }
      return renderTextDocument(attachment.content, isMarkdown);
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
              <a className="attachment-viewer-download" href={sourceUrl} download={attachment.name}>
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
