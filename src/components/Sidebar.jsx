import { useState, useMemo, useRef, useEffect } from 'react';
import { MessageSquare, Plus, Settings, Trash2, Swords, Download, Upload, Search, X, Pencil, Check } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import { formatRelativeDate } from '../lib/formatDate';
import { searchConversations } from '../lib/searchConversations';
import './Sidebar.css';

export default function Sidebar({ open, onClose }) {
  const {
    conversations,
    activeConversationId,
    debateInProgress,
    dispatch,
  } = useDebate();
  const importInputRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const editTitleRef = useRef(null);

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [conversations]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const searchResults = useMemo(
    () => searchConversations(conversations, debouncedQuery),
    [conversations, debouncedQuery]
  );

  const isSearching = searchQuery.length >= 2;

  const handleSearchResultClick = (conversationId) => {
    if (debateInProgress) return;
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: conversationId });
    setSearchQuery('');
  };

  const handleNew = () => {
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: null });
  };

  const handleSelect = (id) => {
    if (debateInProgress) return;
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: id });
  };

  const handleDelete = (e, id) => {
    e.stopPropagation();
    dispatch({ type: 'DELETE_CONVERSATION', payload: id });
  };

  const handleSettings = () => {
    dispatch({ type: 'TOGGLE_SETTINGS' });
  };

  const startEditing = (e, conv) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setEditTitle(conv.title || '');
    setEditDesc(conv.description || '');
    setTimeout(() => editTitleRef.current?.focus(), 0);
  };

  const saveEdit = (convId) => {
    const trimmed = editTitle.trim();
    if (trimmed) {
      dispatch({ type: 'SET_CONVERSATION_TITLE', payload: { conversationId: convId, title: trimmed } });
    }
    dispatch({ type: 'SET_CONVERSATION_DESCRIPTION', payload: { conversationId: convId, description: editDesc.trim() } });
    setEditingId(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const handleEditKeyDown = (e, convId) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit(convId);
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  const downloadJson = (data, filename) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportAll = () => {
    if (conversations.length === 0) return;
    downloadJson(
      { version: 1, exportedAt: new Date().toISOString(), conversations },
      `debate-export-all-${new Date().toISOString().slice(0, 10)}.json`,
    );
  };

  const handleExportOne = (e, conv) => {
    e.stopPropagation();
    const slug = (conv.title || 'debate').replace(/[^a-z0-9]+/gi, '-').slice(0, 40).toLowerCase();
    downloadJson(
      { version: 1, exportedAt: new Date().toISOString(), conversations: [conv] },
      `debate-${slug}-${new Date().toISOString().slice(0, 10)}.json`,
    );
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        // Support: { conversations: [...] }, [...], or a single { id, turns }
        let convs;
        if (data.conversations) {
          convs = data.conversations;
        } else if (Array.isArray(data)) {
          convs = data;
        } else if (data.id && data.turns) {
          convs = [data];
        } else {
          alert('Invalid file format.');
          return;
        }
        const valid = convs.filter(c => c.id && c.turns && Array.isArray(c.turns));
        if (valid.length === 0) {
          alert('No valid conversations found in the file.');
          return;
        }
        dispatch({ type: 'IMPORT_CONVERSATIONS', payload: valid });
        alert(`Imported ${valid.length} conversation(s).`);
      } catch {
        alert('Failed to parse file. Make sure it is a valid JSON export.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <Swords size={20} />
            <span>Debate</span>
          </div>
          <button className="sidebar-btn" onClick={handleNew} title="New debate">
            <Plus size={18} />
          </button>
        </div>

        {conversations.length > 0 && (
          <div className="sidebar-search">
            <div className="sidebar-search-input-wrapper">
              <Search size={14} className="sidebar-search-icon" />
              <input
                type="text"
                className="sidebar-search-input"
                placeholder="Search chats..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="sidebar-search-clear" onClick={() => setSearchQuery('')}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="sidebar-conversations">
          {isSearching ? (
            searchResults.length === 0 ? (
              <div className="sidebar-empty">
                <p>No matches</p>
              </div>
            ) : (
              searchResults.map(result => (
                <div
                  key={result.conversationId}
                  className={`sidebar-item ${result.conversationId === activeConversationId ? 'active' : ''}`}
                  onClick={() => handleSearchResultClick(result.conversationId)}
                >
                  <Search size={14} />
                  <div className="sidebar-item-text">
                    <span className="sidebar-item-title">{result.conversationTitle}</span>
                    <span className="sidebar-search-snippet">{result.snippet}</span>
                    <div className="sidebar-search-meta">
                      <span className="sidebar-search-match-type">{result.matchType}</span>
                      <span className="sidebar-item-date">{formatRelativeDate(result.updatedAt)}</span>
                    </div>
                  </div>
                </div>
              ))
            )
          ) : sortedConversations.length === 0 ? (
            <div className="sidebar-empty">
              <MessageSquare size={24} />
              <p>No debates yet</p>
            </div>
          ) : (
            sortedConversations.map(conv => (
              <div
                key={conv.id}
                className={`sidebar-item ${conv.id === activeConversationId ? 'active' : ''}`}
                onClick={() => editingId !== conv.id && handleSelect(conv.id)}
              >
                <MessageSquare size={14} />
                {editingId === conv.id ? (
                  <div className="sidebar-item-text sidebar-edit-form" onClick={e => e.stopPropagation()}>
                    <input
                      ref={editTitleRef}
                      className="sidebar-edit-input sidebar-edit-title"
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={e => handleEditKeyDown(e, conv.id)}
                      placeholder="Title"
                    />
                    <input
                      className="sidebar-edit-input sidebar-edit-desc"
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      onKeyDown={e => handleEditKeyDown(e, conv.id)}
                      placeholder="Short description (optional)"
                    />
                    <div className="sidebar-edit-actions">
                      <button className="sidebar-edit-btn save" onClick={() => saveEdit(conv.id)} title="Save">
                        <Check size={12} />
                      </button>
                      <button className="sidebar-edit-btn cancel" onClick={cancelEdit} title="Cancel">
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="sidebar-item-text">
                    <span className="sidebar-item-title">{conv.title}</span>
                    {conv.description && (
                      <span className="sidebar-item-desc">{conv.description}</span>
                    )}
                    <span className="sidebar-item-date">{formatRelativeDate(conv.updatedAt)}</span>
                  </div>
                )}
                <div className="sidebar-item-actions">
                  {editingId !== conv.id && (
                    <button
                      className="sidebar-item-action edit"
                      onClick={e => startEditing(e, conv)}
                      title="Edit title"
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                  <button
                    className="sidebar-item-action export"
                    onClick={e => handleExportOne(e, conv)}
                    title="Export chat"
                  >
                    <Download size={12} />
                  </button>
                  <button
                    className="sidebar-item-action delete"
                    onClick={e => handleDelete(e, conv.id)}
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-footer-row">
            <button
              className="sidebar-footer-btn-icon"
              onClick={handleExportAll}
              disabled={conversations.length === 0}
              title="Export chats"
            >
              <Download size={15} />
            </button>
            <button
              className="sidebar-footer-btn-icon"
              onClick={() => importInputRef.current?.click()}
              title="Import chats"
            >
              <Upload size={15} />
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImport}
            />
          </div>
          <button className="sidebar-footer-btn" onClick={handleSettings}>
            <Settings size={16} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
    </>
  );
}
