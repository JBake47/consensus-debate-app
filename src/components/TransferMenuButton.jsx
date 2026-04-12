import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Copy, Check, ChevronDown, Download, FilePenLine, RefreshCcw, Save } from 'lucide-react';
import { useDebateActions } from '../context/DebateContext';
import {
  buildConversationTransferPacketBundle,
  buildTransferPinsFromEditor,
  exportConversationTransferPacket,
  TRANSFER_PACKET_PROFILE_CODING,
  TRANSFER_PACKET_PROFILE_GENERAL,
  TRANSFER_PACKET_PROFILE_RESEARCH,
  TRANSFER_PACKET_VARIANT_COMPACT,
  TRANSFER_PACKET_VARIANT_EXTENDED,
} from '../lib/transferPacket.js';
import './TransferMenuButton.css';

const FEEDBACK_RESET_MS = 2200;
const ResponseViewerModal = lazy(() => import('./ResponseViewerModal'));

const PROFILE_OPTIONS = [
  {
    id: TRANSFER_PACKET_PROFILE_GENERAL,
    label: 'General',
    description: 'Balanced handoff for most chats.',
  },
  {
    id: TRANSFER_PACKET_PROFILE_CODING,
    label: 'Coding',
    description: 'Emphasize run settings, artifacts, and the next implementation step.',
  },
  {
    id: TRANSFER_PACKET_PROFILE_RESEARCH,
    label: 'Research',
    description: 'Emphasize citations, disagreements, and verification gaps.',
  },
];

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
      id: `prepare-${TRANSFER_PACKET_VARIANT_COMPACT}`,
      variant: TRANSFER_PACKET_VARIANT_COMPACT,
      title: 'Prepare Compact',
      description: 'Edit a concise handoff before copying or downloading it.',
    },
    {
      id: `prepare-${TRANSFER_PACKET_VARIANT_EXTENDED}`,
      variant: TRANSFER_PACKET_VARIANT_EXTENDED,
      title: 'Prepare Extended',
      description: 'Edit a longer handoff with recent turn summaries.',
    },
  ];
}

function buildPinsText(values) {
  return Array.isArray(values) ? values.join('\n') : '';
}

function normalizeNotice(value) {
  return String(value || '').trim();
}

function serializePins(pins) {
  return JSON.stringify({
    settledFacts: Array.isArray(pins?.settledFacts) ? pins.settledFacts : [],
    constraints: Array.isArray(pins?.constraints) ? pins.constraints : [],
  });
}

export default function TransferMenuButton({ conversation, className = '' }) {
  const { dispatch } = useDebateActions();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorVariant, setEditorVariant] = useState(TRANSFER_PACKET_VARIANT_COMPACT);
  const [editorProfile, setEditorProfile] = useState(TRANSFER_PACKET_PROFILE_GENERAL);
  const [draft, setDraft] = useState('');
  const [packetMeta, setPacketMeta] = useState(null);
  const [pinnedFactsText, setPinnedFactsText] = useState('');
  const [pinnedConstraintsText, setPinnedConstraintsText] = useState('');
  const [editorNotice, setEditorNotice] = useState('');
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

  const buildPinsOverride = (factsText = pinnedFactsText, constraintsText = pinnedConstraintsText) => (
    buildTransferPinsFromEditor({
      settledFactsText: factsText,
      constraintsText,
    })
  );

  const regenerateDraft = ({
    variant = editorVariant,
    profile = editorProfile,
    factsText = pinnedFactsText,
    constraintsText = pinnedConstraintsText,
  } = {}) => {
    const bundle = buildConversationTransferPacketBundle(conversation, {
      variant,
      profile,
      transferPinsOverride: buildPinsOverride(factsText, constraintsText),
    });
    setEditorVariant(variant);
    setEditorProfile(profile);
    setDraft(bundle.text);
    setPacketMeta(bundle.meta);
    setEditorNotice('');
  };

  const persistPins = ({ silent = false } = {}) => {
    const nextPins = buildPinsOverride();
    const currentPins = serializePins(conversation.transferPins);
    const nextSerializedPins = serializePins(nextPins);
    if (currentPins !== nextSerializedPins) {
      dispatch({
        type: 'SET_CONVERSATION_TRANSFER_PINS',
        payload: {
          conversationId: conversation.id,
          transferPins: nextPins,
        },
      });
      if (!silent) {
        setEditorNotice('Pinned facts and constraints saved for future packets.');
      }
    } else if (!silent) {
      setEditorNotice('Pins are already up to date.');
    }
    return nextPins;
  };

  const openEditorForVariant = (variant) => {
    const nextFactsText = buildPinsText(conversation.transferPins?.settledFacts);
    const nextConstraintsText = buildPinsText(conversation.transferPins?.constraints);
    setPinnedFactsText(nextFactsText);
    setPinnedConstraintsText(nextConstraintsText);
    setEditorOpen(true);
    setOpen(false);
    const bundle = buildConversationTransferPacketBundle(conversation, {
      variant,
      profile: TRANSFER_PACKET_PROFILE_GENERAL,
      transferPinsOverride: buildPinsOverride(nextFactsText, nextConstraintsText),
    });
    setEditorVariant(variant);
    setEditorProfile(TRANSFER_PACKET_PROFILE_GENERAL);
    setDraft(bundle.text);
    setPacketMeta(bundle.meta);
    setEditorNotice('');
  };

  const handleCopyFromEditor = async () => {
    const nextPins = persistPins({ silent: true });
    try {
      await copyTextToClipboard(draft);
      setFeedback(`copied-${editorVariant}`);
      setEditorNotice('Transfer packet copied to the clipboard.');
    } catch {
      exportConversationTransferPacket(conversation, {
        variant: editorVariant,
        profile: editorProfile,
        transferPinsOverride: nextPins,
        contentOverride: draft,
      });
      setFeedback(`downloaded-${editorVariant}`);
      setEditorNotice('Clipboard was unavailable, so the packet was downloaded instead.');
    }
  };

  const handleDownloadFromEditor = () => {
    const nextPins = persistPins({ silent: true });
    exportConversationTransferPacket(conversation, {
      variant: editorVariant,
      profile: editorProfile,
      transferPinsOverride: nextPins,
      contentOverride: draft,
    });
    setFeedback(`downloaded-${editorVariant}`);
    setEditorNotice('Transfer packet downloaded.');
  };

  const sizeRatio = packetMeta?.targetChars
    ? Math.min(1.35, draft.length / packetMeta.targetChars)
    : 0;
  const meterStatus = sizeRatio > 1 ? 'over' : sizeRatio > 0.82 ? 'near' : 'ok';
  const approxTokens = Math.max(1, Math.ceil(draft.length / 4));
  const omissionWarnings = [
    ...(packetMeta?.warnings || []),
    ...((packetMeta?.omittedSections || []).map((section) => `${section} was omitted entirely to stay within the target size.`)),
  ];

  return (
    <div ref={rootRef} className="transfer-menu-root">
      <button
        className={`transfer-menu-trigger ${copied ? 'copied' : ''} ${className}`.trim()}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Prepare a transfer packet for another chat or LLM."
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
              className="transfer-menu-item copy"
              type="button"
              role="menuitem"
              onClick={() => openEditorForVariant(option.variant)}
              title={option.description}
            >
              <span className="transfer-menu-item-icon" aria-hidden="true">
                <FilePenLine size={13} />
              </span>
              <span className="transfer-menu-item-copy">
                <span className="transfer-menu-item-title">{option.title}</span>
                <span className="transfer-menu-item-description">{option.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {editorOpen && (
        <Suspense fallback={null}>
          <ResponseViewerModal open={editorOpen} onClose={() => setEditorOpen(false)} title="Prepare transfer packet">
            <div className="transfer-editor-shell">
              <div className="transfer-editor-header">
                <div className="transfer-editor-heading">
                  <h2>Prepare Transfer Packet</h2>
                  <p>Edit the packet, switch profiles, pin durable facts, then copy or download the result.</p>
                </div>
                <div className="transfer-editor-actions">
                  <button className="transfer-editor-btn ghost" type="button" onClick={() => regenerateDraft()}>
                    <RefreshCcw size={14} />
                    <span>Reset Draft</span>
                  </button>
                  <button className="transfer-editor-btn ghost" type="button" onClick={() => persistPins()}>
                    <Save size={14} />
                    <span>Save Pins</span>
                  </button>
                  <button className="transfer-editor-btn primary" type="button" onClick={() => void handleCopyFromEditor()}>
                    <Copy size={14} />
                    <span>Copy</span>
                  </button>
                  <button className="transfer-editor-btn" type="button" onClick={handleDownloadFromEditor}>
                    <Download size={14} />
                    <span>Download</span>
                  </button>
                </div>
              </div>

              <div className="transfer-editor-toolbar">
                <div className="transfer-editor-control-group">
                  <span className="transfer-editor-control-label">Variant</span>
                  <div className="transfer-editor-pill-group">
                    {[TRANSFER_PACKET_VARIANT_COMPACT, TRANSFER_PACKET_VARIANT_EXTENDED].map((variant) => (
                      <button
                        key={variant}
                        type="button"
                        className={`transfer-editor-pill ${editorVariant === variant ? 'active' : ''}`}
                        onClick={() => regenerateDraft({ variant })}
                      >
                        {variant === TRANSFER_PACKET_VARIANT_COMPACT ? 'Compact' : 'Extended'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="transfer-editor-control-group">
                  <span className="transfer-editor-control-label">Profile</span>
                  <div className="transfer-editor-pill-group">
                    {PROFILE_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`transfer-editor-pill ${editorProfile === option.id ? 'active' : ''}`}
                        onClick={() => regenerateDraft({ profile: option.id })}
                        title={option.description}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="transfer-editor-size-card">
                  <div className="transfer-editor-size-topline">
                    <span>Size</span>
                    <strong>{draft.length.toLocaleString()} chars</strong>
                  </div>
                  <div className="transfer-editor-size-meta">
                    <span>{approxTokens.toLocaleString()} tokens approx.</span>
                    <span>Target {packetMeta?.targetChars?.toLocaleString() || 'n/a'}</span>
                  </div>
                  <div className={`transfer-editor-size-meter ${meterStatus}`}>
                    <span style={{ width: `${Math.min(100, sizeRatio * 100)}%` }} />
                  </div>
                </div>
              </div>

              {(editorNotice || omissionWarnings.length > 0) && (
                <div className="transfer-editor-notices">
                  {normalizeNotice(editorNotice) && (
                    <div className="transfer-editor-notice status">{editorNotice}</div>
                  )}
                  {omissionWarnings.map((warning) => (
                    <div key={warning} className="transfer-editor-notice warning">{warning}</div>
                  ))}
                </div>
              )}

              <div className="transfer-editor-grid">
                <div className="transfer-editor-pins">
                  <label className="transfer-editor-field">
                    <span>Pinned Facts</span>
                    <textarea
                      value={pinnedFactsText}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setPinnedFactsText(nextValue);
                        regenerateDraft({ factsText: nextValue });
                      }}
                      placeholder="One durable fact per line."
                    />
                  </label>
                  <label className="transfer-editor-field">
                    <span>Pinned Constraints</span>
                    <textarea
                      value={pinnedConstraintsText}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setPinnedConstraintsText(nextValue);
                        regenerateDraft({ constraintsText: nextValue });
                      }}
                      placeholder="One lasting preference or constraint per line."
                    />
                  </label>
                </div>

                <label className="transfer-editor-field transfer-editor-draft">
                  <span>Editable Packet Draft</span>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="The generated transfer packet will appear here."
                  />
                </label>
              </div>
            </div>
          </ResponseViewerModal>
        </Suspense>
      )}
    </div>
  );
}
