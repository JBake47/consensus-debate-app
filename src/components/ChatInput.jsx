import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Swords, Square, Globe, Paperclip, X, Send, Zap, Layers, MessageSquare, ChevronDown } from 'lucide-react';
import {
  useDebateActions,
  useDebateConversations,
  useDebateSettings,
  useDebateUi,
} from '../context/DebateContext';
import { estimateTurnBudget } from '../lib/budgetEstimator';
import { formatCostWithQuality } from '../lib/formatTokens';
import AttachmentCard from './AttachmentCard';
import AttachmentViewer from './AttachmentViewer';
import {
  DEFAULT_MAX_ATTACHMENTS,
  buildAttachmentRoutingOverview,
} from '../lib/attachmentRouting';
import { orchestrateMultimodalTurn } from '../lib/multimodalOrchestrator';
import { IMAGE_TYPES, getFileCategory } from '../lib/fileProcessor';
import './ChatInput.css';

const FILE_INPUT_ACCEPT_PARTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.pdf', '.docx', '.xlsx', '.xls', '.xlsm',
  '.txt', '.md', '.mdx', '.csv', '.json', '.xml', '.html', '.htm',
  '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp',
  '.h', '.hpp', '.rs', '.go', '.rb', '.php', '.sh', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.log', '.sql',
];
const SUPPORTED_EXTENSIONS = new Set(FILE_INPUT_ACCEPT_PARTS.map((value) => value.toLowerCase()));
const EXTENSIONLESS_TEXT_NAMES = new Set(['dockerfile', 'makefile', '.env', '.gitignore']);
const SUPPORTED_MIME_HINTS = [
  'application/pdf',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
];
const ATTACHMENT_SUPPORT_SUMMARY = 'Supported: images, PDF, DOCX, XLSX, and text/code files.';

function getFileExtension(name) {
  const fileName = String(name || '').trim();
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function isSupportedAttachment(file) {
  const name = String(file?.name || '').trim().toLowerCase();
  const type = String(file?.type || '').trim().toLowerCase();
  const extension = getFileExtension(name);

  if (SUPPORTED_EXTENSIONS.has(extension) || EXTENSIONLESS_TEXT_NAMES.has(name)) {
    return true;
  }
  if (IMAGE_TYPES.includes(type)) {
    return true;
  }
  if (type.startsWith('text/')) {
    return true;
  }
  return SUPPORTED_MIME_HINTS.some((hint) => type === hint);
}

function formatUnsupportedAttachmentNotice(files) {
  const names = files
    .map((file) => String(file?.name || '').trim() || 'clipboard item')
    .filter(Boolean);
  const preview = names.slice(0, 3).join(', ');
  const remainder = names.length > 3 ? `, +${names.length - 3} more` : '';
  if (names.length === 1) {
    return `"${preview}" is not supported. ${ATTACHMENT_SUPPORT_SUMMARY}`;
  }
  return `${names.length} attachments are not supported (${preview}${remainder}). ${ATTACHMENT_SUPPORT_SUMMARY}`;
}

function createPendingAttachment(file, uploadId) {
  return {
    uploadId,
    name: file?.name || 'attachment',
    size: Number(file?.size || 0),
    type: file?.type || '',
    category: getFileCategory(file),
    content: '',
    preview: 'loading',
    dataUrl: null,
    inlineWarning: null,
    previewMeta: null,
    processingStatus: 'processing',
  };
}

export default function ChatInput() {
  const { startDebate, startDirect, startParallel, cancelDebate, dispatch } = useDebateActions();
  const { debateInProgress, activeConversationId } = useDebateConversations();
  const {
    apiKey,
    selectedModels,
    modelCatalog,
    providerStatus,
    capabilityRegistry,
    synthesizerModel,
    convergenceModel,
    webSearchModel,
    maxDebateRounds,
    budgetGuardrailsEnabled,
    budgetSoftLimitUsd,
    budgetAutoApproveBelowUsd,
  } = useDebateSettings();
  const { webSearchEnabled, chatMode, focusedMode, editingTurn } = useDebateUi();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editMeta, setEditMeta] = useState(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [budgetConfirm, setBudgetConfirm] = useState(null);
  const [orchestrating, setOrchestrating] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState('');
  const [viewerAttachment, setViewerAttachment] = useState(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const modeMenuRef = useRef(null);
  const fileWorkerRef = useRef(null);
  const fileWorkerRequestRef = useRef(0);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    }
  }, [input]);

  // Populate input when editing a previous turn
  useEffect(() => {
    if (editingTurn) {
      setInput(editingTurn.prompt || '');
      setAttachments(editingTurn.attachments || []);
      setEditMeta({ conversationId: editingTurn.conversationId });
      dispatch({ type: 'SET_EDITING_TURN', payload: null });
      // Focus textarea after populating
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [editingTurn, dispatch]);

  const fallbackAttachment = useCallback((file, uploadId = null) => ({
    uploadId,
    name: file?.name || 'attachment',
    size: Number(file?.size || 0),
    type: file?.type || '',
    category: 'error',
    content: '',
    preview: 'error',
    error: 'Failed to process file',
    processingStatus: 'error',
  }), []);

  const ensureFileWorker = useCallback(() => {
    if (!fileWorkerRef.current) {
      fileWorkerRef.current = new Worker(new URL('../workers/fileProcessorWorker.js', import.meta.url), { type: 'module' });
    }
    return fileWorkerRef.current;
  }, []);

  const processFilesOnMainThread = useCallback(async (entries) => {
    const { processFile } = await import('../lib/fileProcessor');
    return Promise.all(
      Array.from(entries).map(async (entry) => {
        const file = entry?.file || entry;
        const uploadId = entry?.uploadId || null;
        try {
          return {
            ...(await processFile(file)),
            uploadId,
          };
        } catch {
          return fallbackAttachment(file, uploadId);
        }
      })
    );
  }, [fallbackAttachment]);

  const processFilesInWorker = useCallback((entries) => {
    const safeEntries = Array.from(entries || []);
    if (safeEntries.length === 0) return Promise.resolve([]);

    return new Promise((resolve, reject) => {
      const worker = ensureFileWorker();
      const requestId = `files-${Date.now()}-${++fileWorkerRequestRef.current}`;

      const cleanup = () => {
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
      };

      const handleMessage = (event) => {
        if (event.data?.requestId !== requestId) return;
        cleanup();
        const nextAttachments = Array.isArray(event.data?.results)
          ? event.data.results.map((result, index) => {
            const fallbackEntry = safeEntries[index];
            return result?.attachment || fallbackAttachment(fallbackEntry?.file || fallbackEntry, fallbackEntry?.uploadId || null);
          })
          : [];
        resolve(nextAttachments);
      };

      const handleError = (error) => {
        cleanup();
        reject(error);
      };

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);
      worker.postMessage({ requestId, files: safeEntries });
    });
  }, [ensureFileWorker, fallbackAttachment]);

  const handleFiles = useCallback(async (files) => {
    const incomingFiles = Array.from(files || []);
    if (incomingFiles.length === 0) return;
    const supportedFiles = incomingFiles.filter((file) => isSupportedAttachment(file));
    const unsupportedFiles = incomingFiles.filter((file) => !isSupportedAttachment(file));
    const remainingSlots = Math.max(0, DEFAULT_MAX_ATTACHMENTS - attachments.length);
    const noticeParts = [];
    if (unsupportedFiles.length > 0) {
      noticeParts.push(formatUnsupportedAttachmentNotice(unsupportedFiles));
    }
    if (remainingSlots <= 0) {
      noticeParts.push(`You can attach up to ${DEFAULT_MAX_ATTACHMENTS} files per turn.`);
      setAttachmentNotice(noticeParts.join(' '));
      return;
    }
    const acceptedFiles = supportedFiles.slice(0, remainingSlots);
    if (supportedFiles.length > acceptedFiles.length) {
      noticeParts.push(
        `Only the first ${remainingSlots} supported file${remainingSlots === 1 ? '' : 's'} were added.`
      );
    }
    if (acceptedFiles.length === 0) {
      setAttachmentNotice(noticeParts.join(' '));
      return;
    }
    const pendingEntries = acceptedFiles.map((file, index) => ({
      file,
      uploadId: `upload-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    }));
    const pendingAttachments = pendingEntries.map(({ file, uploadId }) => createPendingAttachment(file, uploadId));
    setAttachments((prev) => [...prev, ...pendingAttachments]);
    setAttachmentNotice(noticeParts.join(' '));
    setProcessing(true);
    try {
      let processed;
      try {
        processed = await processFilesInWorker(pendingEntries);
      } catch {
        processed = await processFilesOnMainThread(pendingEntries);
      }
      const processedById = new Map(processed.map((attachment) => [attachment.uploadId, attachment]));
      setAttachments((prev) => prev.map((attachment) => (
        processedById.get(attachment.uploadId) || attachment
      )));
    } finally {
      setProcessing(false);
    }
  }, [attachments.length, processFilesInWorker, processFilesOnMainThread]);

  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const performSubmit = useCallback((payload) => {
    const trimmed = String(payload?.prompt || '').trim();
    const currentAttachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    if ((!trimmed && currentAttachments.length === 0) || debateInProgress || orchestrating) return;
    setInput('');
    setAttachments([]);
    const opts = {
      webSearch: webSearchEnabled,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      modelOverrides: Array.isArray(payload?.modelOverrides) ? payload.modelOverrides : undefined,
      routeInfo: payload?.routeInfo || undefined,
    };
    const prompt = trimmed || '(see attachments)';
    if (editMeta?.conversationId && editMeta.conversationId === activeConversationId) {
      dispatch({ type: 'REMOVE_LAST_TURN', payload: editMeta.conversationId });
      setEditMeta(null);
    }
    if (chatMode === 'direct') {
      startDirect(prompt, opts);
    } else if (chatMode === 'parallel') {
      startParallel(prompt, opts);
    } else {
      startDebate(prompt, opts);
    }
  }, [
    debateInProgress,
    webSearchEnabled,
    editMeta?.conversationId,
    activeConversationId,
    dispatch,
    chatMode,
    startDebate,
    startDirect,
    startParallel,
    orchestrating,
  ]);

  const submitWithOrchestration = useCallback(async ({ prompt, attachments: rawAttachments }) => {
    const trimmed = String(prompt || '').trim();
    const currentAttachments = Array.isArray(rawAttachments) ? rawAttachments : [];
    if ((!trimmed && currentAttachments.length === 0) || debateInProgress || orchestrating) return;

    setOrchestrating(true);
    try {
      const orchestrated = await orchestrateMultimodalTurn({
        prompt: trimmed,
        attachments: currentAttachments,
        selectedModels,
        synthesizerModel,
        providerStatus,
        apiKey,
      });

      performSubmit({
        prompt: orchestrated.prompt || trimmed,
        attachments: orchestrated.attachments || currentAttachments,
        modelOverrides: orchestrated.modelOverrides || undefined,
        routeInfo: orchestrated.routeInfo || undefined,
      });
    } catch {
      performSubmit({ prompt: trimmed, attachments: currentAttachments });
    } finally {
      setOrchestrating(false);
    }
  }, [
    debateInProgress,
    orchestrating,
    selectedModels,
    synthesizerModel,
    providerStatus,
    apiKey,
    performSubmit,
  ]);

  const budgetEstimate = useMemo(() => estimateTurnBudget({
    prompt: input.trim(),
    attachments,
    mode: chatMode,
    selectedModels,
    synthesizerModel,
    convergenceModel,
    webSearchModel,
    maxDebateRounds,
    webSearchEnabled,
    modelCatalog,
  }), [
    input,
    attachments,
    chatMode,
    selectedModels,
    synthesizerModel,
    convergenceModel,
    webSearchModel,
    maxDebateRounds,
    webSearchEnabled,
    modelCatalog,
  ]);
  const budgetEstimateLabel = formatCostWithQuality({
    totalCost: budgetEstimate.totalEstimatedCost,
    quality: budgetEstimate.quality,
  });

  const attachmentRouting = useMemo(() => buildAttachmentRoutingOverview({
    attachments,
    models: selectedModels,
    modelCatalog,
    capabilityRegistry,
  }), [attachments, selectedModels, modelCatalog, capabilityRegistry]);

  const sendableAttachmentCount = useMemo(() => attachmentRouting.reduce((count, route) => {
    if (!route || route.state !== 'ready') return count;
    return count + ((route.nativeModels.length > 0 || route.fallbackModels.length > 0) ? 1 : 0);
  }, 0), [attachmentRouting]);

  const anyAttachmentProcessing = attachments.some((attachment) => attachment.processingStatus === 'processing');
  const canSubmit = (!input.trim() && sendableAttachmentCount === 0)
    ? false
    : (!debateInProgress && !orchestrating && !anyAttachmentProcessing);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if ((!trimmed && sendableAttachmentCount === 0) || debateInProgress || orchestrating || anyAttachmentProcessing) return;

    const estimatedCost = Number(budgetEstimate.totalEstimatedCost || 0);
    const softLimit = Number(budgetSoftLimitUsd || 0);
    const autoApproveBelow = Number(budgetAutoApproveBelowUsd || 0);
    const shouldConfirmBudget = Boolean(budgetGuardrailsEnabled) &&
      estimatedCost > 0 &&
      estimatedCost > softLimit &&
      estimatedCost > autoApproveBelow;

    if (shouldConfirmBudget) {
      setBudgetConfirm({
        estimatedCost,
        estimateLabel: budgetEstimateLabel,
        prompt: trimmed,
        attachments,
      });
      return;
    }

    submitWithOrchestration({ prompt: trimmed, attachments });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) handleSubmit();
    }
  };

  const toggleWebSearch = () => {
    dispatch({ type: 'SET_WEB_SEARCH_ENABLED', payload: !webSearchEnabled });
  };

  const setChatMode = (mode) => {
    dispatch({ type: 'SET_CHAT_MODE', payload: mode });
  };

  const placeholderByMode = {
    debate: 'Ask a hard question for a deeper debate...',
    direct: 'Ask for one ensemble answer...',
    parallel: 'Ask to compare model answers...',
  };

  const modeOptions = [
    { id: 'debate', label: 'Debate', icon: <Swords size={14} /> },
    { id: 'direct', label: 'Ensemble', icon: <MessageSquare size={14} /> },
    { id: 'parallel', label: 'Parallel', icon: <Layers size={14} /> },
  ];

  const submitLabelByMode = {
    debate: 'Run Debate',
    direct: 'Get Answer',
    parallel: 'Run Parallel',
  };

  useEffect(() => {
    if (!modeMenuOpen) return;
    const handleClickOutside = (event) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(event.target)) {
        setModeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modeMenuOpen]);

  useEffect(() => {
    const handleFocusComposer = () => {
      textareaRef.current?.focus();
    };
    window.addEventListener('consensus:focus-composer', handleFocusComposer);
    return () => window.removeEventListener('consensus:focus-composer', handleFocusComposer);
  }, []);

  useEffect(() => {
    const handlePrefillComposer = (event) => {
      const prompt = String(event.detail?.prompt || '').trim();
      if (!prompt) return;
      setInput(prompt);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('consensus:prefill-composer', handlePrefillComposer);
    return () => window.removeEventListener('consensus:prefill-composer', handlePrefillComposer);
  }, []);

  useEffect(() => () => {
    fileWorkerRef.current?.terminate();
    fileWorkerRef.current = null;
  }, []);

  useEffect(() => {
    if (!debateInProgress) return;
    setBudgetConfirm(null);
  }, [debateInProgress]);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files?.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  return (
    <div className="chat-input-wrapper">
      <div
        className={`chat-input-container glass-panel ${dragOver ? 'drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="drag-overlay">
            <Paperclip size={24} />
            <div className="drag-overlay-copy">
              <span className="drag-overlay-title">Drop supported files here</span>
              <span className="drag-overlay-hint">
                {ATTACHMENT_SUPPORT_SUMMARY} Up to {DEFAULT_MAX_ATTACHMENTS} files per turn.
              </span>
            </div>
          </div>
        )}

        {editMeta && (
          <div className="edit-mode-banner">
            <span>Editing last message</span>
          </div>
        )}

        {budgetConfirm && (
          <div className="budget-confirm-banner">
            <div className="budget-confirm-copy">
              Estimated cost {budgetConfirm.estimateLabel || '$0.00'} exceeds your soft limit.
            </div>
            <div className="budget-confirm-actions">
              <button
                className="chat-btn chat-btn-cancel-edit"
                onClick={() => setBudgetConfirm(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="chat-btn chat-btn-submit"
                onClick={() => {
                  submitWithOrchestration({
                    prompt: budgetConfirm.prompt,
                    attachments: budgetConfirm.attachments,
                  });
                  setBudgetConfirm(null);
                }}
                type="button"
              >
                Send Anyway
              </button>
            </div>
          </div>
        )}

        {attachmentNotice && (
          <div className="attachment-warning">{attachmentNotice}</div>
        )}

        {attachments.length > 0 && (
          <div className="attachment-tray">
            {attachments.map((att, i) => (
              <AttachmentCard
                key={att.uploadId || `${att.name}-${i}`}
                attachment={att}
                routing={attachmentRouting[i]}
                onPreview={() => setViewerAttachment(att)}
                onRemove={() => removeAttachment(i)}
              />
            ))}
          </div>
        )}

        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder={placeholderByMode[chatMode] || 'Ask a question...'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={false}
          />
          <div className="chat-input-footer">
            <div className="chat-input-toggles">
              <button
                className={`chat-toggle ${webSearchEnabled ? 'active' : ''}`}
                onClick={toggleWebSearch}
                disabled={debateInProgress}
                title={webSearchEnabled ? 'Web search enabled' : 'Enable web search'}
              >
                <Globe size={15} />
                <span>Search</span>
              </button>
              <div className="chat-mode-select-wrapper" ref={modeMenuRef}>
                <button
                  className="chat-mode-select"
                  onClick={() => setModeMenuOpen((open) => !open)}
                  disabled={debateInProgress}
                  aria-haspopup="listbox"
                  aria-expanded={modeMenuOpen}
                  type="button"
                >
                  <span className="chat-mode-select-icon">
                    {modeOptions.find(option => option.id === chatMode)?.icon}
                  </span>
                  <span>{modeOptions.find(option => option.id === chatMode)?.label || 'Mode'}</span>
                  <ChevronDown size={12} className="chat-mode-select-caret" />
                </button>
                {modeMenuOpen && !debateInProgress && (
                  <div className="chat-mode-menu" role="listbox" aria-label="Chat mode">
                    {modeOptions.map((option) => (
                      <button
                        key={option.id}
                        className={`chat-mode-option ${chatMode === option.id ? 'active' : ''}`}
                        onClick={() => {
                          setChatMode(option.id);
                          setModeMenuOpen(false);
                        }}
                        role="option"
                        aria-selected={chatMode === option.id}
                        type="button"
                      >
                        <span className="chat-mode-option-icon">{option.icon}</span>
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className={`chat-toggle ${focusedMode ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'SET_FOCUSED_MODE', payload: !focusedMode })}
                disabled={debateInProgress}
                title={focusedMode ? 'Shorter replies enabled' : 'Prefer shorter, sharper replies'}
              >
                <Zap size={15} />
                <span>Shorter</span>
              </button>
              <button
                className="chat-toggle"
                onClick={() => fileInputRef.current?.click()}
                disabled={debateInProgress || processing || orchestrating}
                title="Attach files"
              >
                <Paperclip size={15} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={e => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="chat-input-actions">
              {debateInProgress ? (
                <button className="chat-btn chat-btn-cancel" onClick={() => cancelDebate()}>
                  <Square size={16} />
                  <span>Stop</span>
                </button>
              ) : (
                <>
                  {editMeta && (
                    <button
                      className="chat-btn chat-btn-cancel-edit"
                      onClick={() => {
                        setInput('');
                        setAttachments([]);
                        setEditMeta(null);
                      }}
                    >
                      <X size={16} />
                      <span>Cancel Edit</span>
                    </button>
                  )}
                  <button
                    className={`chat-btn chat-btn-submit ${chatMode === 'direct' ? 'ensemble' : ''} ${chatMode === 'parallel' ? 'parallel' : ''}`}
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                  >
                    {chatMode === 'debate' && <Swords size={16} />}
                    {chatMode === 'direct' && <Send size={16} />}
                    {chatMode === 'parallel' && <Layers size={16} />}
                    <span>{submitLabelByMode[chatMode] || 'Send'}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="chat-input-hint">
        Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line {' | '} Drag and drop or paste files
        {anyAttachmentProcessing && ' | Processing attachments...'}
        {orchestrating && ' | Preparing multimodal tools...'}
        {budgetEstimateLabel && (
          <>
            {' | '} Est. turn cost <strong>{budgetEstimateLabel}</strong>
          </>
        )}
      </p>
      {viewerAttachment && (
        <AttachmentViewer attachment={viewerAttachment} onClose={() => setViewerAttachment(null)} />
      )}
    </div>
  );
}
