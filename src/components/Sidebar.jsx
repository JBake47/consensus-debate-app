import { useState, useMemo, useRef, useEffect } from 'react';
import { MessageSquare, Plus, Settings, Trash2, Download, Upload, Search, X, Pencil, Check, Share2 } from 'lucide-react';
import { useDebate } from '../context/DebateContext';
import { formatRelativeDate } from '../lib/formatDate';
import { searchConversations } from '../lib/searchConversations';
import { exportConversationReport } from '../lib/reportExport';
import './Sidebar.css';

export default function Sidebar({ open, onClose }) {
  const {
    conversations,
    activeConversationId,
    isConversationInProgress,
    metrics,
    dispatch,
  } = useDebate();
  const importInputRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
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

  useEffect(() => {
    if (!deleteTarget) return;
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        closeDeleteModal();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [deleteTarget]);

  const searchResults = useMemo(
    () => searchConversations(conversations, debouncedQuery),
    [conversations, debouncedQuery]
  );

  const isSearching = searchQuery.length >= 2;

  const metricsSummary = useMemo(() => {
    const callCount = Number(metrics?.callCount || 0);
    const successCount = Number(metrics?.successCount || 0);
    const failureCount = Number(metrics?.failureCount || 0);
    const retryAttempts = Number(metrics?.retryAttempts || 0);
    const retryRecovered = Number(metrics?.retryRecovered || 0);
    const samples = Array.isArray(metrics?.firstAnswerTimes) ? metrics.firstAnswerTimes : [];
    const avgFirstAnswerMs = samples.length > 0
      ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
      : null;
    const providerFailures = metrics?.failureByProvider && typeof metrics.failureByProvider === 'object'
      ? Object.entries(metrics.failureByProvider).sort((a, b) => b[1] - a[1])
      : [];

    return {
      hasData: callCount > 0 || failureCount > 0 || retryAttempts > 0,
      successRate: callCount > 0 ? Math.round((successCount / callCount) * 100) : null,
      avgFirstAnswerMs,
      retryRecovered,
      retryAttempts,
      topProviderFailure: providerFailures[0] || null,
    };
  }, [metrics]);

  const handleSearchResultClick = (conversationId) => {
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: conversationId });
    setSearchQuery('');
  };

  const handleNew = () => {
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: null });
  };

  const handleSelect = (id) => {
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: id });
  };

  const handleDelete = (e, conv) => {
    e.stopPropagation();
    setDeleteTarget(conv);
  };

  const closeDeleteModal = () => {
    setDeleteTarget(null);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    dispatch({ type: 'DELETE_CONVERSATION', payload: deleteTarget.id });
    setDeleteTarget(null);
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
      dispatch({
        type: 'SET_CONVERSATION_TITLE',
        payload: { conversationId: convId, title: trimmed, source: 'user' },
      });
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

  const handleShareReport = (e, conv) => {
    e.stopPropagation();
    exportConversationReport(conv);
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
            <img className="sidebar-logo-mark" src="/consensus.svg" alt="Consensus logo" />
            <span>Consensus</span>
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
            sortedConversations.map(conv => {
              const conversationRunning = Boolean(isConversationInProgress?.(conv.id));
              return (
                <div
                  key={conv.id}
                  className={`sidebar-item ${conv.id === activeConversationId ? 'active' : ''} ${conversationRunning ? 'in-progress' : ''}`}
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
                      {conversationRunning && (
                        <span className="sidebar-item-running">Running...</span>
                      )}
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
                      className="sidebar-item-action share"
                      onClick={e => handleShareReport(e, conv)}
                      title="Export share report"
                    >
                      <Share2 size={12} />
                    </button>
                    <button
                      className="sidebar-item-action export"
                      onClick={e => handleExportOne(e, conv)}
                      title="Export chat"
                    >
                      <Download size={12} />
                    </button>
                    <button
                      className="sidebar-item-action delete"
                      onClick={e => handleDelete(e, conv)}
                      title={conversationRunning ? 'Stop this chat before deleting' : 'Delete'}
                      disabled={conversationRunning}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {deleteTarget?.id === conv.id && (
                    <div className="sidebar-inline-confirm" onClick={(e) => e.stopPropagation()}>
                      <div className="sidebar-inline-confirm-title">Delete chat?</div>
                      <div className="sidebar-inline-confirm-meta">
                        {conv.title || 'Untitled chat'}
                      </div>
                      <div className="sidebar-inline-confirm-actions">
                        <button className="sidebar-inline-confirm-btn ghost" onClick={closeDeleteModal}>
                          Cancel
                        </button>
                        <button className="sidebar-inline-confirm-btn danger" onClick={confirmDelete}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="sidebar-footer">
          {metricsSummary.hasData && (
            <div className="sidebar-metrics">
              <div className="sidebar-metrics-title">Reliability</div>
              <div className="sidebar-metrics-grid">
                <div className="sidebar-metric">
                  <span>Success</span>
                  <strong>{metricsSummary.successRate != null ? `${metricsSummary.successRate}%` : '--'}</strong>
                </div>
                <div className="sidebar-metric">
                  <span>First answer</span>
                  <strong>{metricsSummary.avgFirstAnswerMs != null ? `${metricsSummary.avgFirstAnswerMs}ms` : '--'}</strong>
                </div>
                <div className="sidebar-metric">
                  <span>Recovered retries</span>
                  <strong>{metricsSummary.retryRecovered}/{metricsSummary.retryAttempts}</strong>
                </div>
              </div>
              {metricsSummary.topProviderFailure && (
                <div className="sidebar-metrics-foot">
                  Most failures: {metricsSummary.topProviderFailure[0]} ({metricsSummary.topProviderFailure[1]})
                </div>
              )}
            </div>
          )}
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
