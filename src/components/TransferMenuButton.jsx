import { useEffect, useRef, useState } from 'react';
import { Copy, Check, ChevronDown, Download } from 'lucide-react';
import {
  buildConversationTransferPacket,
  exportConversationTransferPacket,
  TRANSFER_PACKET_VARIANT_COMPACT,
  TRANSFER_PACKET_VARIANT_EXTENDED,
} from '../lib/transferPacket.js';
import './TransferMenuButton.css';

const FEEDBACK_RESET_MS = 2200;

async function copyTextToClipboard(text) {
  if (!text) return false;

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  if (typeof document === 'undefined' || !document.body) {
    throw new Error('Clipboard unavailable.');
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand('copy');
    if (!copied) {
      throw new Error('Clipboard unavailable.');
    }
    return true;
  } finally {
    document.body.removeChild(textarea);
  }
}

function buildMenuOptions() {
  return [
    {
      id: `copy-${TRANSFER_PACKET_VARIANT_COMPACT}`,
      kind: 'copy',
      variant: TRANSFER_PACKET_VARIANT_COMPACT,
      title: 'Copy Compact',
      description: 'One concise handoff for another LLM.',
    },
    {
      id: `copy-${TRANSFER_PACKET_VARIANT_EXTENDED}`,
      kind: 'copy',
      variant: TRANSFER_PACKET_VARIANT_EXTENDED,
      title: 'Copy Extended',
      description: 'Compact handoff plus recent turn summaries.',
    },
    {
      id: `download-${TRANSFER_PACKET_VARIANT_COMPACT}`,
      kind: 'download',
      variant: TRANSFER_PACKET_VARIANT_COMPACT,
      title: 'Download Compact',
      description: 'Save the concise handoff as Markdown.',
    },
    {
      id: `download-${TRANSFER_PACKET_VARIANT_EXTENDED}`,
      kind: 'download',
      variant: TRANSFER_PACKET_VARIANT_EXTENDED,
      title: 'Download Extended',
      description: 'Save the longer handoff as Markdown.',
    },
  ];
}

export default function TransferMenuButton({ conversation, className = '' }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const rootRef = useRef(null);

  useEffect(() => {
    if (!feedback) return undefined;
    const timer = window.setTimeout(() => setFeedback(''), FEEDBACK_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!conversation) return null;

  const copied = feedback.startsWith('copied');
  const downloaded = feedback.startsWith('downloaded');
  const buttonLabel = copied
    ? 'Copied'
    : downloaded
      ? 'Saved'
      : 'Transfer';

  const handleCopy = async (variant) => {
    const packet = buildConversationTransferPacket(conversation, { variant });
    try {
      await copyTextToClipboard(packet);
      setFeedback(`copied-${variant}`);
    } catch {
      exportConversationTransferPacket(conversation, { variant });
      setFeedback(`downloaded-${variant}`);
    } finally {
      setOpen(false);
    }
  };

  const handleDownload = (variant) => {
    exportConversationTransferPacket(conversation, { variant });
    setFeedback(`downloaded-${variant}`);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="transfer-menu-root">
      <button
        className={`transfer-menu-trigger ${copied ? 'copied' : ''} ${className}`.trim()}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Copy or download a transfer packet for another chat or LLM."
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{buttonLabel}</span>
        <ChevronDown size={12} className={`transfer-menu-caret ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="transfer-menu-panel" role="menu" aria-label="Transfer packet options">
          {buildMenuOptions().map((option) => (
            <button
              key={option.id}
              className={`transfer-menu-item ${option.kind}`}
              type="button"
              role="menuitem"
              onClick={() => {
                if (option.kind === 'copy') {
                  void handleCopy(option.variant);
                  return;
                }
                handleDownload(option.variant);
              }}
              title={option.description}
            >
              <span className="transfer-menu-item-icon" aria-hidden="true">
                {option.kind === 'copy' ? <Copy size={13} /> : <Download size={13} />}
              </span>
              <span className="transfer-menu-item-copy">
                <span className="transfer-menu-item-title">{option.title}</span>
                <span className="transfer-menu-item-description">{option.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
