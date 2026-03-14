import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Download } from 'lucide-react';
import { formatFileSize } from '../lib/formatFileSize';
import MarkdownRenderer from './MarkdownRenderer';
import './AttachmentViewer.css';

function isLikelyMarkdown(name) {
  return /\.mdx?$/i.test(name || '');
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

    const pageElement = pageRef.current;
    const scrollRoot = scrollRootRef.current;
    if (!pageElement || !scrollRoot) return undefined;

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

    if (!pdfDoc || !canvasRef.current || !shouldRender) return undefined;

    setIsRendering(true);

    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
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

        renderTaskRef.current = page.render({ canvasContext: context, viewport });
        await renderTaskRef.current.promise;
        if (!cancelled) {
          setIsRendering(false);
        }
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
      }
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
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfError, setPdfError] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [pdfPageSize, setPdfPageSize] = useState(null);
  const pdfLoadIdRef = useRef(0);
  const pdfScrollRef = useRef(null);

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
    setImageError('');
  }, [attachment?.name, attachment?.dataUrl, attachment?.downloadUrl]);

  const downloadUrl = attachment?.downloadUrl || attachment?.dataUrl || objectUrl;
  const canDownload = Boolean(downloadUrl);
  const isMarkdown = useMemo(() => isLikelyMarkdown(attachment?.name), [attachment?.name]);
  const pdfPageNumbers = useMemo(
    () => Array.from({ length: Math.max(0, pdfPages) }, (_, index) => index + 1),
    [pdfPages]
  );

  const handlePdfRenderError = useCallback(() => {
    setPdfError((current) => current || 'Unable to render PDF preview.');
  }, []);

  const scrollToPdfPage = useCallback((targetPage) => {
    const boundedPage = Math.max(1, Math.min(pdfPages || targetPage, targetPage));
    const pageElement = pdfScrollRef.current?.querySelector(`[data-pdf-page="${boundedPage}"]`);
    if (!pageElement) return;
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPdfPage(boundedPage);
  }, [pdfPages]);

  useEffect(() => {
    let cancelled = false;
    const currentLoadId = pdfLoadIdRef.current + 1;
    pdfLoadIdRef.current = currentLoadId;

    const resetPdfState = () => {
      setPdfDoc(null);
      setPdfPages(0);
      setPdfPage(1);
      setPdfScale(1);
      setPdfPageSize(null);
      setPdfError('');
      setPdfLoading(false);
    };

    const pdfSource = attachment?.dataUrl || attachment?.downloadUrl || '';
    if (!attachment || attachment.category !== 'pdf' || !pdfSource) {
      resetPdfState();
      return undefined;
    }

    setPdfLoading(true);
    setPdfError('');
    setPdfDoc(null);

    (async () => {
      try {
        const pdfjsLib = await loadPdfjs();
        const doc = await pdfjsLib.getDocument(pdfSource).promise;
        if (cancelled || pdfLoadIdRef.current !== currentLoadId) {
          doc.destroy();
          return;
        }
        const firstPage = await doc.getPage(1);
        if (cancelled || pdfLoadIdRef.current !== currentLoadId) {
          doc.destroy();
          return;
        }
        const firstViewport = firstPage.getViewport({ scale: 1 });
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
        if (!cancelled) {
          setPdfError(formatAssetLoadError(error, 'Unable to load PDF preview.'));
          setPdfLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attachment, loadPdfjs]);

  useEffect(() => {
    return () => {
      if (pdfDoc) {
        pdfDoc.destroy();
      }
    };
  }, [pdfDoc]);

  useEffect(() => {
    const container = pdfScrollRef.current;
    if (!container || pdfPageNumbers.length === 0) return undefined;

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
  }, [pdfPageNumbers, pdfScale]);

  if (!attachment) return null;

  const renderTextDocument = (content, markdown = false) => (
    <div className="attachment-viewer-document">
      <div className="attachment-viewer-document-scroll attachment-viewer-text">
        {markdown ? <MarkdownRenderer>{content}</MarkdownRenderer> : <pre>{content}</pre>}
      </div>
    </div>
  );

  const renderBody = () => {
    const imageSrc = attachment?.dataUrl || attachment?.downloadUrl || '';
    if (attachment.category === 'image' && imageSrc) {
      if (imageError) {
        return <div className="attachment-viewer-message">{imageError}</div>;
      }
      return (
        <div className="attachment-viewer-media">
          <img
            className="attachment-viewer-image"
            src={imageSrc}
            alt={attachment.name}
            onError={() => setImageError('Unable to preview image. The generated file link may have expired.')}
          />
        </div>
      );
    }

    if (attachment.category === 'pdf') {
      if (!attachment.dataUrl && !attachment.downloadUrl) {
        if (attachment.content) {
          return renderTextDocument(attachment.content);
        }
        return <div className="attachment-viewer-message">{attachment.inlineWarning || 'Preview unavailable.'}</div>;
      }
      if (pdfError) {
        return <div className="attachment-viewer-message">{pdfError}</div>;
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
              onClick={() => setPdfScale(scale => Math.max(0.5, Number((scale - 0.1).toFixed(2))))}
              disabled={pdfLoading}
            >
              -
            </button>
            <span>{Math.round(pdfScale * 100)}%</span>
            <button
              type="button"
              onClick={() => setPdfScale(scale => Math.min(3, Number((scale + 0.1).toFixed(2))))}
              disabled={pdfLoading}
            >
              +
            </button>
            <button type="button" onClick={() => setPdfScale(1)} disabled={pdfLoading}>Reset</button>
          </div>
          <div className="attachment-viewer-pdf-pages" ref={pdfScrollRef}>
            {pdfLoading && <div className="attachment-viewer-message">Loading PDF...</div>}
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

    if (attachment.category === 'text') {
      if (!attachment.content) {
        return <div className="attachment-viewer-message">No text content available.</div>;
      }
      return renderTextDocument(attachment.content, isMarkdown);
    }

    if (attachment.content) {
      return renderTextDocument(attachment.content);
    }

    return <div className="attachment-viewer-message">{attachment.inlineWarning || 'Preview unavailable.'}</div>;
  };

  return (
    <div className="attachment-viewer-overlay" onClick={onClose}>
      <div className="attachment-viewer-modal" onClick={(e) => e.stopPropagation()}>
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
            <button className="attachment-viewer-close" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="attachment-viewer-body">
          {renderBody()}
        </div>
      </div>
    </div>
  );
}
