import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Download } from 'lucide-react';
import { formatFileSize } from '../lib/fileProcessor';
import MarkdownRenderer from './MarkdownRenderer';
import './AttachmentViewer.css';

function isLikelyMarkdown(name) {
  return /\.mdx?$/i.test(name || '');
}

export default function AttachmentViewer({ attachment, onClose }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfError, setPdfError] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const pdfLoadIdRef = useRef(0);

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

  const downloadUrl = attachment?.dataUrl || objectUrl;
  const canDownload = Boolean(downloadUrl);
  const isMarkdown = useMemo(() => isLikelyMarkdown(attachment?.name), [attachment?.name]);

  useEffect(() => {
    let cancelled = false;
    const currentLoadId = pdfLoadIdRef.current + 1;
    pdfLoadIdRef.current = currentLoadId;

    const resetPdfState = () => {
      setPdfDoc(null);
      setPdfPages(0);
      setPdfPage(1);
      setPdfScale(1);
      setPdfError('');
      setPdfLoading(false);
    };

    if (!attachment || attachment.category !== 'pdf' || !attachment.dataUrl) {
      resetPdfState();
      return undefined;
    }

    setPdfLoading(true);
    setPdfError('');
    setPdfDoc(null);

    (async () => {
      try {
        const pdfjsLib = await loadPdfjs();
        const doc = await pdfjsLib.getDocument(attachment.dataUrl).promise;
        if (cancelled || pdfLoadIdRef.current !== currentLoadId) {
          doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setPdfPages(doc.numPages || 0);
        setPdfPage(1);
        setPdfScale(1);
        setPdfLoading(false);
      } catch {
        if (!cancelled) {
          setPdfError('Unable to load PDF preview.');
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
    let cancelled = false;

    if (!pdfDoc || !canvasRef.current) return undefined;

    (async () => {
      try {
        const page = await pdfDoc.getPage(pdfPage);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: pdfScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        renderTaskRef.current = page.render({ canvasContext: context, viewport });
        await renderTaskRef.current.promise;
      } catch {
        if (!cancelled) {
          setPdfError('Unable to render PDF page.');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
    };
  }, [pdfDoc, pdfPage, pdfScale]);

  if (!attachment) return null;

  const renderBody = () => {
    if (attachment.category === 'image' && attachment.dataUrl) {
      return <img className="attachment-viewer-image" src={attachment.dataUrl} alt={attachment.name} />;
    }

    if (attachment.category === 'pdf') {
      if (!attachment.dataUrl) {
        if (attachment.content) {
          return (
            <div className="attachment-viewer-text">
              <pre>{attachment.content}</pre>
            </div>
          );
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
              onClick={() => setPdfPage(page => Math.max(1, page - 1))}
              disabled={pdfPage <= 1 || pdfLoading}
            >
              Prev
            </button>
            <span>Page {pdfPage} / {pdfPages || '-'}</span>
            <button
              type="button"
              onClick={() => setPdfPage(page => Math.min(pdfPages || page + 1, page + 1))}
              disabled={pdfPages === 0 || pdfPage >= pdfPages || pdfLoading}
            >
              Next
            </button>
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
          <div className="attachment-viewer-pdf-canvas">
            {pdfLoading && <div className="attachment-viewer-message">Loading PDF...</div>}
            <canvas ref={canvasRef} />
          </div>
        </div>
      );
    }

    if (attachment.category === 'text') {
      if (!attachment.content) {
        return <div className="attachment-viewer-message">No text content available.</div>;
      }
      return (
        <div className="attachment-viewer-text">
          {isMarkdown ? <MarkdownRenderer>{attachment.content}</MarkdownRenderer> : <pre>{attachment.content}</pre>}
        </div>
      );
    }

    if (attachment.content) {
      return (
        <div className="attachment-viewer-text">
          <pre>{attachment.content}</pre>
        </div>
      );
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
