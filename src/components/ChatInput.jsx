import { useState, useRef, useEffect, useCallback } from 'react';
import { Swords, Square, Globe, Paperclip, X, FileText, Image as ImageIcon, MessageSquare, Send, Zap } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import { processFile, formatFileSize } from '../lib/fileProcessor';
import './ChatInput.css';

export default function ChatInput() {
  const { startDebate, startDirect, cancelDebate, debateInProgress, apiKey, webSearchEnabled, chatMode, focusedMode, editingTurn, dispatch } = useDebate();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

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
    if (chatMode === 'direct') {
      startDirect(prompt, opts);
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

  const toggleChatMode = () => {
    dispatch({ type: 'SET_CHAT_MODE', payload: chatMode === 'debate' ? 'direct' : 'debate' });
  };

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
            <span>Drop files here</span>
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

        <div className="chat-input-row">
          <div className="chat-input-toggles">
            <button
              className={`chat-toggle ${webSearchEnabled ? 'active' : ''}`}
              onClick={toggleWebSearch}
              disabled={debateInProgress || !apiKey}
              title={webSearchEnabled ? 'Web search enabled' : 'Enable web search'}
            >
              <Globe size={15} />
              <span>Search</span>
            </button>
            <button
              className={`chat-toggle ${chatMode === 'debate' ? 'active' : ''}`}
              onClick={toggleChatMode}
              disabled={debateInProgress || !apiKey}
              title={chatMode === 'debate' ? 'Debate mode: multi-round discussion' : 'Ensemble mode: vote-weighted synthesis'}
            >
              {chatMode === 'debate' ? <Swords size={15} /> : <MessageSquare size={15} />}
              <span>{chatMode === 'debate' ? 'Debate' : 'Ensemble'}</span>
            </button>
            <button
              className={`chat-toggle ${focusedMode ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'SET_FOCUSED_MODE', payload: !focusedMode })}
              disabled={debateInProgress || !apiKey}
              title={focusedMode ? 'Focused mode: concise, direct responses' : 'Enable focused mode for shorter, sharper outputs'}
            >
              <Zap size={15} />
              <span>Focused</span>
            </button>
            <button
              className="chat-toggle"
              onClick={() => fileInputRef.current?.click()}
              disabled={debateInProgress || !apiKey || processing}
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
            placeholder={apiKey
              ? (chatMode === 'debate' ? 'Ask a question to debate across models...' : 'Ask a question...')
              : 'Set your API key in Settings to begin...'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={!apiKey}
          />
          <div className="chat-input-actions">
            {debateInProgress ? (
              <button className="chat-btn chat-btn-cancel" onClick={cancelDebate}>
                <Square size={16} />
                <span>Stop</span>
              </button>
            ) : (
              <button
                className={`chat-btn chat-btn-submit ${chatMode === 'direct' ? 'ensemble' : ''}`}
                onClick={handleSubmit}
                disabled={(!input.trim() && attachments.length === 0) || !apiKey}
              >
                {chatMode === 'debate' ? <Swords size={16} /> : <Send size={16} />}
                <span>{chatMode === 'debate' ? 'Debate' : 'Send'}</span>
              </button>
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
