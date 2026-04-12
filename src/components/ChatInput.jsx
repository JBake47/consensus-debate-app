import { lazy, Suspense, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Swords, Square, Globe, Paperclip, X, Send, Zap, Layers, MessageSquare, ChevronDown, Loader2 } from 'lucide-react';
import {
  useDebateActions,
  useDebateConversations,
  useDebateSettings,
  useDebateUi,
} from '../context/DebateContext';
import { estimateTurnBudget } from '../lib/budgetEstimator';
import { formatCostWithQuality } from '../lib/formatTokens';
import AttachmentCard from './AttachmentCard';
import {
  DEFAULT_MAX_ATTACHMENTS,
  buildAttachmentRoutingOverview,
} from '../lib/attachmentRouting';
import { orchestrateMultimodalTurn } from '../lib/multimodalOrchestrator';
import { IMAGE_TYPES, getFileCategory } from '../lib/fileTypes';
import InfoTip from './InfoTip';
import './ChatInput.css';

const AttachmentViewer = lazy(() => import('./AttachmentViewer'));

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

function formatAttachmentLoadingLabel(processingAttachments) {
  const pending = Array.isArray(processingAttachments) ? processingAttachments : [];
  if (pending.length === 0) return '';
  if (pending.length === 1) {
    const name = String(pending[0]?.name || 'attachment').trim() || 'attachment';
    return `Loading ${name}`;
  }
  return `Loading ${pending.length} attachments`;
}

export default function ChatInput() {
  const {
    startDebate,
    startDirect,
    startParallel,
    prepareConversationForHistoryMutation,
    cancelDebate,
    dispatch,
  } = useDebateActions();
  const { debateInProgress, activeConversationIsMostRecent } = useDebateConversations();
  const {
    apiKey,
    selectedModels,
    modelCatalog,
    providerStatus,
    providerStatusState,
    capabilityRegistry,
    synthesizerModel,
    convergenceModel,
    webSearchModel,
    maxDebateRounds,
    budgetGuardrailsEnabled,
    budgetSoftLimitUsd,
    budgetAutoApproveBelowUsd,
  } = useDebateSettings();
  const {
    webSearchEnabled,
    chatMode,
    focusedMode,
    editingTurn,
    conversationStoreStatus,
  } = useDebateUi();
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
  const modeMenuButtonRef = useRef(null);
  const modeOptionRefs = useRef([]);
  const fileWorkerRef = useRef(null);
  const fileWorkerRequestRef = useRef(0);
  const fileProcessingLockRef = useRef(false);
  const conversationStoreReady = conversationStoreStatus === 'ready';
  const hasConfiguredProvider = Boolean(String(apiKey || '').trim())
    || Object.values(providerStatus || {}).some(Boolean);
  const providerStateReady = providerStatusState === 'ready';
  const requiresProviderSetup = providerStateReady && !hasConfiguredProvider;

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
          const fileCategory = getFileCategory(file);
          return {
            ...(await processFile(file, {
              safePdfFallback: fileCategory === 'pdf',
            })),
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
    if (!conversationStoreReady) return;
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
    if (fileProcessingLockRef.current) {
      noticeParts.push('Wait for current attachment previews to finish loading before adding more.');
      setAttachmentNotice(noticeParts.join(' '));
      return;
    }
    fileProcessingLockRef.current = true;
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
      fileProcessingLockRef.current = false;
      setProcessing(false);
    }
  }, [attachments.length, conversationStoreReady, processFilesInWorker, processFilesOnMainThread]);

  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const performSubmit = useCallback((payload) => {
    const trimmed = String(payload?.prompt || '').trim();
    const currentAttachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    if ((!trimmed && currentAttachments.length === 0) || !conversationStoreReady || debateInProgress || orchestrating || requiresProviderSetup) return;
    setInput('');
    setAttachments([]);
    const opts = {
      webSearch: webSearchEnabled,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      modelOverrides: Array.isArray(payload?.modelOverrides) ? payload.modelOverrides : undefined,
      routeInfo: payload?.routeInfo || undefined,
    };
    const prompt = trimmed || '(see attachments)';
    if (editMeta?.conversationId) {
      const {
        conversationId: targetConversationId,
        conversationSnapshot,
      } = prepareConversationForHistoryMutation(editMeta.conversationId, {
        titleLabel: 'Edit',
        branchKind: 'edit',
        sourceStage: 'turn',
        sourceSummary: 'Edited Last Prompt',
      });
      if (!targetConversationId) return;
      dispatch({ type: 'REMOVE_LAST_TURN', payload: targetConversationId });
      opts.conversationId = targetConversationId;
      opts.conversationSnapshot = conversationSnapshot
        ? {
          ...conversationSnapshot,
          turns: Array.isArray(conversationSnapshot.turns)
            ? conversationSnapshot.turns.slice(0, -1)
            : [],
        }
        : null;
      opts.skipAutoTitle = true;
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
    prepareConversationForHistoryMutation,
    dispatch,
    chatMode,
    startDebate,
    startDirect,
    startParallel,
    orchestrating,
    conversationStoreReady,
    requiresProviderSetup,
  ]);

  const submitWithOrchestration = useCallback(async ({ prompt, attachments: rawAttachments }) => {
    const trimmed = String(prompt || '').trim();
    const currentAttachments = Array.isArray(rawAttachments) ? rawAttachments : [];
    if ((!trimmed && currentAttachments.length === 0) || !conversationStoreReady || debateInProgress || orchestrating || requiresProviderSetup) return;

    setOrchestrating(true);
    try {
      const orchestrated = await orchestrateMultimodalTurn({
        prompt: trimmed,
        attachments: currentAttachments,
        selectedModels,
        synthesizerModel,
        providerStatus,
        apiKey,
        modelCatalog,
        capabilityRegistry,
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
    conversationStoreReady,
    selectedModels,
    synthesizerModel,
    providerStatus,
    apiKey,
    modelCatalog,
    capabilityRegistry,
    performSubmit,
    requiresProviderSetup,
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

  const processingAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.processingStatus === 'processing'),
    [attachments]
  );
  const anyAttachmentProcessing = processingAttachments.length > 0;
  const attachmentLoadingLabel = useMemo(
    () => formatAttachmentLoadingLabel(processingAttachments),
    [processingAttachments]
  );
  const attachmentLoadingDetail = processingAttachments.length > 1
    ? 'Preparing previews and routing before you can send.'
    : 'Preparing the preview and routing before you can send.';
  const attachmentControlBusy = processing || anyAttachmentProcessing;
  const canSubmit = (!input.trim() && sendableAttachmentCount === 0)
    ? false
    : (conversationStoreReady && !debateInProgress && !orchestrating && !anyAttachmentProcessing && !requiresProviderSetup);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if ((!trimmed && sendableAttachmentCount === 0) || debateInProgress || orchestrating || anyAttachmentProcessing || requiresProviderSetup) return;

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
    {
      id: 'debate',
      label: 'Debate',
      icon: <Swords size={14} />,
      description: 'Models rebut each other across rounds, then synthesis combines the outcome.',
    },
    {
      id: 'direct',
      label: 'Ensemble',
      icon: <MessageSquare size={14} />,
      description: 'Fastest path to one merged answer when you want clarity over process.',
    },
    {
      id: 'parallel',
      label: 'Parallel',
      icon: <Layers size={14} />,
      description: 'Show each model side by side when you want to compare raw outputs yourself.',
    },
  ];

  const submitLabelByMode = {
    debate: 'Run Debate',
    direct: 'Get Answer',
    parallel: 'Run Parallel',
  };
  const selectedModeIndex = Math.max(0, modeOptions.findIndex((option) => option.id === chatMode));
  const selectedModeOption = modeOptions[selectedModeIndex] || modeOptions[0];
  const selectedModeTitle = selectedModeOption
    ? `${selectedModeOption.label}: ${selectedModeOption.description} Configure models and rounds in Settings.`
    : 'Choose how the app should answer this turn.';
  const submitTitle = chatMode === 'debate'
    ? 'Run a multi-round debate, then synthesize the result. Configure the roster and rounds in Settings.'
    : chatMode === 'parallel'
      ? 'Run each selected model separately so you can compare raw outputs side by side.'
      : 'Get one merged answer quickly by synthesizing the selected models without running rebuttal rounds.';

  const focusModeOption = useCallback((index) => {
    requestAnimationFrame(() => {
      modeOptionRefs.current[index]?.focus();
    });
  }, []);

  const closeModeMenu = useCallback((restoreFocus = false) => {
    setModeMenuOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        modeMenuButtonRef.current?.focus();
      });
    }
  }, []);

  const selectModeOption = useCallback((mode) => {
    setChatMode(mode);
    closeModeMenu(true);
  }, [closeModeMenu]);

  const openModeMenu = useCallback((index = selectedModeIndex) => {
    if (!conversationStoreReady || debateInProgress) return;
    setModeMenuOpen(true);
    focusModeOption(Math.max(0, Math.min(index, modeOptions.length - 1)));
  }, [conversationStoreReady, debateInProgress, focusModeOption, selectedModeIndex, modeOptions.length]);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const handleClickOutside = (event) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(event.target)) {
        closeModeMenu();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [closeModeMenu, modeMenuOpen]);

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
    if (!conversationStoreReady) return;
    if (e.dataTransfer.files?.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handlePaste = (e) => {
    if (!conversationStoreReady) return;
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

  const handleModeTriggerKeyDown = (event) => {
    if (!conversationStoreReady || debateInProgress) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openModeMenu(selectedModeIndex);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      openModeMenu(modeOptions.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (modeMenuOpen) {
        closeModeMenu();
      } else {
        openModeMenu(selectedModeIndex);
      }
      return;
    }
    if (event.key === 'Escape' && modeMenuOpen) {
      event.preventDefault();
      closeModeMenu(true);
    }
  };

  const handleModeOptionKeyDown = (event, optionIndex, optionId) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusModeOption((optionIndex + 1) % modeOptions.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusModeOption((optionIndex - 1 + modeOptions.length) % modeOptions.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusModeOption(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusModeOption(modeOptions.length - 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeModeMenu();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectModeOption(optionId);
    }
  };

  const textareaPlaceholder = !conversationStoreReady
    ? 'Restoring chats...'
    : requiresProviderSetup
      ? 'Open Settings to connect a provider before sending...'
      : (placeholderByMode[chatMode] || 'Ask a question...');

  return (
    <div className="chat-input-wrapper">
      <div
        className={`chat-input-container glass-panel ${dragOver ? 'drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        title="Composer area. Type a prompt, toggle Search or mode, then send. You can also drag, paste, or attach supported files here."
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
            <span>
              {activeConversationIsMostRecent
                ? 'Editing last message'
                : 'Editing last message. Sending will create a new branch.'}
            </span>
          </div>
        )}

        {requiresProviderSetup && (
          <div className="provider-setup-banner">
            <div className="provider-setup-copy">
              Add an OpenRouter key or enable a direct provider in Settings before sending your first turn.
            </div>
            <button
              className="chat-btn chat-btn-provider"
              onClick={() => dispatch({ type: 'SET_SHOW_SETTINGS', payload: true })}
              type="button"
              title="Open Settings to connect OpenRouter or a direct provider before sending."
            >
              Open Settings
            </button>
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
                title="Cancel this send and return to editing the prompt."
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
                title="Send this turn even though the estimated cost is above your soft limit."
              >
                Send Anyway
              </button>
            </div>
          </div>
        )}

        {attachmentNotice && (
          <div className="attachment-warning">{attachmentNotice}</div>
        )}

        <div className="chat-input-row">
          <div className={`chat-textarea-shell ${attachments.length > 0 ? 'has-attachments' : ''}`}>
            {attachments.length > 0 && (
              <div className="attachment-tray attachment-tray-inline">
                {attachments.map((att, i) => (
                  <AttachmentCard
                    key={att.uploadId || `${att.name}-${i}`}
                    attachment={att}
                    routing={attachmentRouting[i]}
                    compact
                    showTransport={false}
                    onPreview={() => setViewerAttachment(att)}
                    onRemove={() => removeAttachment(i)}
                  />
                ))}
              </div>
            )}
            {anyAttachmentProcessing && (
              <div className="attachment-processing-banner" role="status" aria-live="polite">
                <span className="attachment-processing-banner-icon" aria-hidden="true">
                  <Loader2 size={14} className="attachment-processing-spinner" />
                </span>
                <span className="attachment-processing-banner-copy">
                  <span className="attachment-processing-banner-title">{attachmentLoadingLabel}</span>
                  <span className="attachment-processing-banner-detail">{attachmentLoadingDetail}</span>
                </span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              placeholder={textareaPlaceholder}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
              disabled={!conversationStoreReady}
              aria-label="Prompt composer"
              title="Prompt composer. Press Enter to send, Shift+Enter for a new line. Drag, paste, or attach files to include context."
            />
          </div>
          <div className="chat-input-footer">
            <div className="chat-input-toggles">
              <div className="chat-control-with-help">
                <button
                  className={`chat-toggle ${webSearchEnabled ? 'active' : ''}`}
                  onClick={toggleWebSearch}
                  disabled={!conversationStoreReady || debateInProgress}
                  aria-pressed={webSearchEnabled}
                  aria-label={webSearchEnabled
                    ? 'Search is on for this turn. The configured web-search model will gather live sources before answering.'
                    : 'Turn on live web search for this turn. Configure the search model and strict verification in Settings.'}
                  title={webSearchEnabled
                    ? 'Search is on for this turn. The configured web-search model will gather live sources before answering.'
                    : 'Turn on live web search for this turn. Configure the search model and strict verification in Settings > Models.'}
                >
                  <Globe size={15} />
                  <span>Search</span>
                </button>
                <InfoTip
                  content={webSearchEnabled
                    ? [
                      'Search is on for this turn.',
                      'The configured web-search model will gather live sources before the answer is generated.',
                      'Use Settings > Models to change the search model or strict verification rules.',
                    ]
                    : [
                      'Turn on live web search when you want current evidence instead of model memory alone.',
                      'Configure the search model and strict verification rules in Settings > Models.',
                    ]}
                  label="Search help"
                />
              </div>
              <div className="chat-control-with-help">
                <div className="chat-mode-select-wrapper" ref={modeMenuRef}>
                  <button
                    ref={modeMenuButtonRef}
                    className="chat-mode-select"
                    onClick={() => setModeMenuOpen((open) => !open)}
                    onKeyDown={handleModeTriggerKeyDown}
                    disabled={!conversationStoreReady || debateInProgress}
                    aria-haspopup="listbox"
                    aria-expanded={modeMenuOpen}
                    aria-controls="chat-mode-menu"
                    aria-label={selectedModeTitle}
                    title={selectedModeTitle}
                    type="button"
                  >
                    <span className="chat-mode-select-icon">
                      {selectedModeOption?.icon}
                    </span>
                    <span>{selectedModeOption?.label || 'Mode'}</span>
                    <ChevronDown size={12} className="chat-mode-select-caret" />
                  </button>
                  {modeMenuOpen && conversationStoreReady && !debateInProgress && (
                    <div id="chat-mode-menu" className="chat-mode-menu" role="listbox" aria-label="Chat mode">
                      {modeOptions.map((option, index) => (
                        <button
                          key={option.id}
                          ref={(element) => {
                            modeOptionRefs.current[index] = element;
                          }}
                          className={`chat-mode-option ${chatMode === option.id ? 'active' : ''}`}
                          onClick={() => selectModeOption(option.id)}
                          onKeyDown={(event) => handleModeOptionKeyDown(event, index, option.id)}
                          role="option"
                          aria-selected={chatMode === option.id}
                          aria-label={`${option.label}. ${option.description}`}
                          title={`${option.label}: ${option.description}`}
                          type="button"
                        >
                          <span className="chat-mode-option-icon">{option.icon}</span>
                          <span className="chat-mode-option-copy">
                            <span>{option.label}</span>
                            <span className="chat-mode-option-description">{option.description}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <InfoTip
                  content={[
                    'Choose how the app should answer this turn.',
                    'Debate runs rebuttal rounds before synthesis.',
                    'Ensemble gives you one merged answer quickly.',
                    'Parallel shows each model output side by side.',
                  ]}
                  label="Chat mode help"
                />
              </div>
              <div className="chat-control-with-help">
                <button
                  className={`chat-toggle ${focusedMode ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'SET_FOCUSED_MODE', payload: !focusedMode })}
                  disabled={!conversationStoreReady || debateInProgress}
                  aria-pressed={focusedMode}
                  aria-label={focusedMode
                    ? 'Shorter mode is on. Prompts ask models for tighter, more concise replies.'
                    : 'Prefer shorter, sharper replies for this turn. Turn this off when you want more detail.'}
                  title={focusedMode
                    ? 'Shorter mode is on. Prompts ask models for tighter, more concise replies.'
                    : 'Prefer shorter, sharper replies for this turn. Turn this off when you want more detail.'}
                >
                  <Zap size={15} />
                  <span>Shorter</span>
                </button>
                <InfoTip
                  content={focusedMode
                    ? [
                      'Shorter mode is on.',
                      'The prompt asks models for tighter, more concise replies.',
                      'Turn it off when you want fuller explanations or more detail.',
                    ]
                    : [
                      'Use Shorter when you want tighter answers with less filler.',
                      'Turn it off when you want fuller explanations or more detailed debate output.',
                    ]}
                  label="Shorter mode help"
                />
              </div>
              <div className="chat-control-with-help">
                <button
                  className="chat-toggle"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!conversationStoreReady || debateInProgress || attachmentControlBusy || orchestrating}
                  aria-label={attachmentControlBusy
                    ? 'Loading attached files into the app. Wait for previews to finish preparing.'
                    : `Attach files to this turn. ${ATTACHMENT_SUPPORT_SUMMARY}`}
                  title={attachmentControlBusy
                    ? 'Loading attached files into the app. Wait for previews and routing to finish before adding more.'
                    : `Attach files to this turn. ${ATTACHMENT_SUPPORT_SUMMARY} Hover each attachment after upload to see how it will be routed.`}
                >
                  {attachmentControlBusy ? (
                    <Loader2 size={15} className="chat-attachment-button-spinner" />
                  ) : (
                    <Paperclip size={15} />
                  )}
                </button>
                <InfoTip
                  content={[
                    'Attach files to include extra context with this turn.',
                    ATTACHMENT_SUPPORT_SUMMARY,
                    'After upload, each attachment card explains how it will be routed.',
                  ]}
                  label="Attachment help"
                />
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                aria-label="Attach files"
                onChange={e => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="chat-input-actions">
              {debateInProgress ? (
                <button className="chat-btn chat-btn-cancel" onClick={() => cancelDebate()} title="Stop the active run. Completed outputs remain in the turn so you can inspect or retry them.">
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
                      title="Discard this edit draft and keep the original turn unchanged."
                    >
                      <X size={16} />
                      <span>Cancel Edit</span>
                    </button>
                  )}
                  <div className="chat-control-with-help">
                    <button
                      className={`chat-btn chat-btn-submit ${chatMode === 'direct' ? 'ensemble' : ''} ${chatMode === 'parallel' ? 'parallel' : ''}`}
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                      aria-label={submitTitle}
                      title={submitTitle}
                    >
                      {chatMode === 'debate' && <Swords size={16} />}
                      {chatMode === 'direct' && <Send size={16} />}
                      {chatMode === 'parallel' && <Layers size={16} />}
                      <span>{submitLabelByMode[chatMode] || 'Send'}</span>
                    </button>
                    <InfoTip
                      content={submitTitle}
                      label={`${submitLabelByMode[chatMode] || 'Send'} help`}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="chat-input-hint">
        Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line {' | '} Drag and drop or paste files
        {!conversationStoreReady && ' | Restoring saved chats...'}
        {requiresProviderSetup && ' | Open Settings to connect a provider'}
        {anyAttachmentProcessing && ' | Loading attachments...'}
        {orchestrating && ' | Preparing multimodal tools...'}
        {budgetEstimateLabel && (
          <>
            {' | '} Est. turn cost <strong>{budgetEstimateLabel}</strong>
          </>
        )}
      </p>
      {viewerAttachment && (
        <Suspense fallback={null}>
          <AttachmentViewer attachment={viewerAttachment} onClose={() => setViewerAttachment(null)} />
        </Suspense>
      )}
    </div>
  );
}
