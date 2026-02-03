import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Swords, Square, Globe, Paperclip, X, FileText, Image as ImageIcon, Send, Zap, Layers, MessageSquare, ChevronDown } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import { processFile, formatFileSize } from '../lib/fileProcessor';
import { getImageIncompatibleModels } from '../lib/modelCapabilities';
import './ChatInput.css';

export default function ChatInput() {
  const {
    startDebate,
    startDirect,
    startParallel,
    cancelDebate,
    debateInProgress,
    webSearchEnabled,
    chatMode,
    focusedMode,
    editingTurn,
    activeConversation,
    selectedModels,
    modelCatalog,
    modelCatalogStatus,
    dispatch,
  } = useDebate();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editMeta, setEditMeta] = useState(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const modeMenuRef = useRef(null);

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

  const handleFiles = useCallback(async (files) => {
    if (!files || files.length === 0) return;
    setProcessing(true);
    try {
      const processed = await Promise.all(
        Array.from(files).map(f => processFile(f).catch(() => ({
          name: f.name,
          size: f.size,
          type: f.type,
          category: 'error',
          content: '',
          preview: 'error',
          error: 'Failed to process file',
        })))
      );
      setAttachments(prev => [...prev, ...processed]);
    } finally {
      setProcessing(false);
    }
  }, []);

  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || debateInProgress) return;
    const currentAttachments = attachments;
    setInput('');
    setAttachments([]);
    const opts = {
      webSearch: webSearchEnabled,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
    };
    const prompt = trimmed || '(see attachments)';
    if (editMeta?.conversationId && editMeta.conversationId === activeConversation?.id) {
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
    debate: 'Ask a question to debate across models...',
    direct: 'Ask a question...',
    parallel: 'Ask a question for parallel responses...',
  };

  const modeOptions = [
    { id: 'debate', label: 'Debate', icon: <Swords size={14} /> },
    { id: 'direct', label: 'Ensemble', icon: <MessageSquare size={14} /> },
    { id: 'parallel', label: 'Parallel', icon: <Layers size={14} /> },
  ];

  const submitLabelByMode = {
    debate: 'Debate',
    direct: 'Send',
    parallel: 'Parallel',
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
              title={focusedMode ? 'Focused mode: concise, direct responses' : 'Enable focused mode for shorter, sharper outputs'}
            >
              <Zap size={15} />
              <span>Focused</span>
            </button>
            <button
              className="chat-toggle"
              onClick={() => fileInputRef.current?.click()}
              disabled={debateInProgress || processing}
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
          <div className="chat-input-actions">
            {debateInProgress ? (
              <button className="chat-btn chat-btn-cancel" onClick={cancelDebate}>
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
                  disabled={!input.trim() && attachments.length === 0}
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
      <p className="chat-input-hint">
        Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line &middot; Drag & drop or paste files
      </p>
    </div>
  );
}
