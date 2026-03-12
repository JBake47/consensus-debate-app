import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Swords, Square, Globe, Paperclip, X, FileText, Image as ImageIcon, Send, Zap, Layers, MessageSquare, ChevronDown } from 'lucide-react';
import {
  useDebateActions,
  useDebateConversations,
  useDebateSettings,
  useDebateUi,
} from '../context/DebateContext';
import { getImageIncompatibleModels } from '../lib/modelCapabilities';
import { estimateTurnBudget } from '../lib/budgetEstimator';
import { formatCostWithQuality } from '../lib/formatTokens';
import { formatFileSize } from '../lib/formatFileSize';
import { orchestrateMultimodalTurn } from '../lib/multimodalOrchestrator';
import './ChatInput.css';

export default function ChatInput() {
  const { startDebate, startDirect, startParallel, cancelDebate, dispatch } = useDebateActions();
  const { debateInProgress, activeConversationId } = useDebateConversations();
  const {
    apiKey,
    selectedModels,
    modelCatalog,
    modelCatalogStatus,
    providerStatus,
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

  const fallbackAttachment = useCallback((file) => ({
    name: file?.name || 'attachment',
    size: Number(file?.size || 0),
    type: file?.type || '',
    category: 'error',
    content: '',
    preview: 'error',
    error: 'Failed to process file',
  }), []);

  const ensureFileWorker = useCallback(() => {
    if (!fileWorkerRef.current) {
      fileWorkerRef.current = new Worker(new URL('../workers/fileProcessorWorker.js', import.meta.url), { type: 'module' });
    }
    return fileWorkerRef.current;
  }, []);

  const processFilesOnMainThread = useCallback(async (files) => {
    const { processFile } = await import('../lib/fileProcessor');
    return Promise.all(
      Array.from(files).map((file) => processFile(file).catch(() => fallbackAttachment(file)))
    );
  }, [fallbackAttachment]);

  const processFilesInWorker = useCallback((files) => {
    const safeFiles = Array.from(files || []);
    if (safeFiles.length === 0) return Promise.resolve([]);

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
          ? event.data.results.map((entry, index) => entry?.attachment || fallbackAttachment(safeFiles[index]))
          : [];
        resolve(nextAttachments);
      };

      const handleError = (error) => {
        cleanup();
        reject(error);
      };

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);
      worker.postMessage({ requestId, files: safeFiles });
    });
  }, [ensureFileWorker, fallbackAttachment]);

  const handleFiles = useCallback(async (files) => {
    if (!files || files.length === 0) return;
    setProcessing(true);
    try {
      let processed;
      try {
        processed = await processFilesInWorker(files);
      } catch {
        processed = await processFilesOnMainThread(files);
      }
      setAttachments((prev) => [...prev, ...processed]);
    } finally {
      setProcessing(false);
    }
  }, [processFilesInWorker, processFilesOnMainThread]);

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

  const handleSubmit = () => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || debateInProgress || orchestrating) return;

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
      handleSubmit();
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

  const hasImageAttachment = useMemo(
    () => attachments.some(att => att.category === 'image'),
    [attachments]
  );

  const imageIncompatibleModels = useMemo(() => {
    if (!hasImageAttachment || modelCatalogStatus !== 'ready') return [];
    return getImageIncompatibleModels(selectedModels, modelCatalog);
  }, [hasImageAttachment, modelCatalogStatus, selectedModels, modelCatalog]);

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
            <span>Drop files here</span>
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

        {attachments.length > 0 && (
          <div className="attachment-chips">
            {attachments.map((att, i) => (
              <div key={i} className={`attachment-chip ${att.category}`}>
                {att.category === 'image' ? <ImageIcon size={13} /> : <FileText size={13} />}
                <span className="attachment-chip-name">{att.name}</span>
                <span className="attachment-chip-size">{formatFileSize(att.size)}</span>
                <button className="attachment-chip-remove" onClick={() => removeAttachment(i)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {hasImageAttachment && imageIncompatibleModels.length > 0 && (
          <div className="attachment-warning">
            Images will not be sent to: {imageIncompatibleModels.join(', ')}
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
                    disabled={(!input.trim() && attachments.length === 0) || orchestrating}
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
        {orchestrating && ' | Preparing multimodal tools...'}
        {budgetEstimateLabel && (
          <>
            {' | '} Est. turn cost <strong>{budgetEstimateLabel}</strong>
          </>
        )}
      </p>
    </div>
  );
}
