import { useDeferredValue, useState, useMemo, useRef, useEffect } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { MessageSquare, Plus, Settings, Trash2, Download, Upload, Search, X, Pencil, Check, Share2, GitBranchPlus } from 'lucide-react';
import { useDebateActions, useDebateConversationList } from '../context/DebateContext';
import { formatRelativeDate } from '../lib/formatDate';
import { buildConversationSearchIndex, searchConversationIndex } from '../lib/searchConversations';
import { sortSidebarConversations } from '../lib/sidebarOrdering';
import { describeConversationBranch } from '../lib/conversationBranching';
import InfoTip from './InfoTip';
import './Sidebar.css';

export default function Sidebar({ open }) {
  const { dispatch } = useDebateActions();
  const {
    conversations,
    activeConversationId,
    isConversationInProgress,
    getConversationById,
    getConversationsSnapshot,
  } = useDebateConversationList();
  const importInputRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [importFeedback, setImportFeedback] = useState(null);
  const editTitleRef = useRef(null);

  const sortedConversations = useMemo(
    () => sortSidebarConversations(
      conversations,
      (conversationId) => Boolean(isConversationInProgress?.(conversationId)),
    ),
    [conversations, isConversationInProgress]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);

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

  useEffect(() => {
    if (!importFeedback) return undefined;
    const timer = window.setTimeout(() => setImportFeedback(null), 3200);
    return () => window.clearTimeout(timer);
  }, [importFeedback]);

  const searchIndex = useMemo(
    () => buildConversationSearchIndex(conversations),
    [conversations]
  );

  const searchResults = useMemo(
    () => searchConversationIndex(searchIndex, deferredQuery, 50),
    [searchIndex, deferredQuery]
  );

  const isSearching = searchQuery.length >= 2;
  const handleSearchResultClick = (result) => {
    const conversationId = result?.conversationId || null;
    if (!conversationId) return;
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: conversationId });
    if (Number.isInteger(result?.turnIndex) && result.turnIndex >= 0) {
      dispatch({
        type: 'SET_PENDING_TURN_FOCUS',
        payload: {
          conversationId,
          turnIndex: result.turnIndex,
          requestedAt: Date.now(),
        },
      });
    }
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
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: true });
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
    const fullConversations = getConversationsSnapshot?.() || [];
    if (fullConversations.length === 0) return;
    downloadJson(
      { version: 1, exportedAt: new Date().toISOString(), conversations: fullConversations },
      `debate-export-all-${new Date().toISOString().slice(0, 10)}.json`,
    );
  };

  const handleExportOne = (e, conv) => {
    e.stopPropagation();
    const fullConversation = getConversationById?.(conv.id);
    if (!fullConversation) return;
    const slug = (fullConversation.title || 'debate').replace(/[^a-z0-9]+/gi, '-').slice(0, 40).toLowerCase();
    downloadJson(
      { version: 1, exportedAt: new Date().toISOString(), conversations: [fullConversation] },
      `debate-${slug}-${new Date().toISOString().slice(0, 10)}.json`,
    );
  };

  const handleSelectableKeyDown = (event, callback) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    callback?.();
  };

  const handleConversationKeyDown = (event, conversationId) => {
    handleSelectableKeyDown(event, () => {
      if (editingId === conversationId) return;
      handleSelect(conversationId);
    });
  };

  const handleSearchResultKeyDown = (event, result) => {
    handleSelectableKeyDown(event, () => handleSearchResultClick(result));
  };

  const handleShareReportAsync = async (conv) => {
    const fullConversation = getConversationById?.(conv.id);
    if (!fullConversation) return;
    const { exportConversationReport } = await import('../lib/reportExport');
    exportConversationReport(fullConversation);
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
          setImportFeedback({ tone: 'error', message: 'Invalid file format.' });
          return;
        }
        const valid = convs.filter(c => c.id && c.turns && Array.isArray(c.turns));
        if (valid.length === 0) {
          setImportFeedback({ tone: 'error', message: 'No valid conversations found in the file.' });
          return;
        }
        dispatch({ type: 'IMPORT_CONVERSATIONS', payload: valid });
        setImportFeedback({ tone: 'success', message: `Imported ${valid.length} chat${valid.length === 1 ? '' : 's'}.` });
      } catch {
        setImportFeedback({ tone: 'error', message: 'Failed to parse file. Use a valid JSON export.' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const renderConversationItem = (conv) => {
    const conversationRunning = Boolean(isConversationInProgress?.(conv.id));
    const parentConversation = conv.parentConversationId
      ? getConversationById?.(conv.parentConversationId)
      : null;
    const branchLineage = describeConversationBranch(conv.branchedFrom, parentConversation?.title || '');
    return (
      <div
        key={conv.id}
        className={`sidebar-item ${conv.id === activeConversationId ? 'active' : ''} ${conversationRunning ? 'in-progress' : ''}`}
        onClick={() => editingId !== conv.id && handleSelect(conv.id)}
        onKeyDown={editingId === conv.id ? undefined : (event) => handleConversationKeyDown(event, conv.id)}
        role={editingId === conv.id ? undefined : 'button'}
        tabIndex={editingId === conv.id ? undefined : 0}
        aria-current={conv.id === activeConversationId ? 'page' : undefined}
        aria-label={editingId === conv.id ? undefined : 'Open this chat. Use the action buttons to rename, export, report, or delete it.'}
        title={editingId === conv.id ? undefined : 'Open this chat. Use the action buttons to rename, export, report, or delete it.'}
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
              aria-label="Rename this chat"
              title="Rename this chat."
            />
            <input
              className="sidebar-edit-input sidebar-edit-desc"
              value={editDesc}
              onChange={e => setEditDesc(e.target.value)}
              onKeyDown={e => handleEditKeyDown(e, conv.id)}
              placeholder="Short description (optional)"
              aria-label="Optional description shown under the chat title"
              title="Optional description shown under the chat title."
            />
            <div className="sidebar-edit-actions">
              <button className="sidebar-edit-btn save" onClick={() => saveEdit(conv.id)} aria-label="Save the edited title and description" title="Save the edited title and description." type="button">
                <Check size={12} />
              </button>
              <button className="sidebar-edit-btn cancel" onClick={cancelEdit} aria-label="Cancel editing and keep the current title" title="Cancel editing and keep the current title." type="button">
                <X size={12} />
              </button>
            </div>
          </div>
        ) : (
          <div className="sidebar-item-text">
            <div className="sidebar-item-title-row">
              <span className="sidebar-item-title">{conv.title}</span>
              {branchLineage && (
                <span className="sidebar-branch-badge" title={branchLineage.tooltip}>
                  <GitBranchPlus size={10} />
                  <span>{branchLineage.badgeLabel}</span>
                </span>
              )}
            </div>
            <div className="sidebar-item-meta">
              <span className="sidebar-item-date">{formatRelativeDate(conv.updatedAt)}</span>
              {branchLineage?.parentLabel && (
                <span className="sidebar-item-caption" title={branchLineage.tooltip}>
                  {branchLineage.caption}
                </span>
              )}
            </div>
            {conversationRunning && (
              <span className="sidebar-item-running">
                <span className="sidebar-item-running-spinner" aria-hidden="true" />
                Running
              </span>
            )}
          </div>
        )}
        <div className="sidebar-item-actions">
          {editingId !== conv.id && (
            <button
              className="sidebar-item-action edit"
              onClick={e => startEditing(e, conv)}
              aria-label="Rename this chat and edit its short description"
              title="Rename this chat and edit its short description."
              type="button"
            >
              <Pencil size={12} />
            </button>
          )}
            <button
              className="sidebar-item-action share"
              onClick={(event) => {
                event.stopPropagation();
                void handleShareReportAsync(conv);
              }}
              aria-label="Export a readable report for this chat"
              title="Export a readable report for this chat."
              type="button"
            >
              <Share2 size={12} />
            </button>
            <button
              className="sidebar-item-action export"
              onClick={e => handleExportOne(e, conv)}
              aria-label="Export this chat as JSON so it can be imported later"
              title="Export this chat as JSON so it can be imported later."
              type="button"
            >
              <Download size={12} />
            </button>
            <button
              className="sidebar-item-action delete"
              onClick={e => handleDelete(e, conv)}
              aria-label={conversationRunning ? 'Stop this chat before deleting' : 'Delete this chat'}
              title={conversationRunning ? 'Stop this chat before deleting' : 'Delete'}
              disabled={conversationRunning}
              type="button"
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
              <button className="sidebar-inline-confirm-btn ghost" onClick={closeDeleteModal} type="button">
                Cancel
              </button>
              <button className="sidebar-inline-confirm-btn danger" onClick={confirmDelete} type="button">
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {open && <div className="sidebar-overlay" />}
      <aside id="app-sidebar" className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <img className="sidebar-logo-mark" src="/consensus.svg" alt="Consensus logo" />
            <span>Consensus</span>
          </div>
          <div className="sidebar-header-actions">
            <button className="sidebar-btn" onClick={handleNew} aria-label="Start a new chat with the current global settings" title="Start a new chat with the current global settings." type="button">
              <Plus size={18} />
            </button>
            <InfoTip
              content={[
                'Start a new chat with the current global settings.',
                'Your existing chats stay in the sidebar so you can switch back at any time.',
              ]}
              label="New chat help"
            />
          </div>
        </div>

        {conversations.length > 0 && (
          <div className="sidebar-search">
            <div className="sidebar-search-heading">
              <span className="sidebar-search-label">Search</span>
              <InfoTip
                content={[
                  'Search across chat titles, prompts, and responses.',
                  'Choosing a result opens the matching chat and jumps to the related turn when possible.',
                ]}
                label="Chat search help"
              />
            </div>
            <div className="sidebar-search-input-wrapper">
              <Search size={14} className="sidebar-search-icon" />
              <input
                type="text"
                className="sidebar-search-input"
                placeholder="Search chats..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="Search across chat titles, prompts, and responses"
                title="Search across chat titles, prompts, and responses. Search results can jump directly to a matching turn."
              />
              {searchQuery && (
                <button className="sidebar-search-clear" onClick={() => setSearchQuery('')} type="button" aria-label="Clear the current chat search" title="Clear the current chat search.">
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
                  onClick={() => handleSearchResultClick(result)}
                  onKeyDown={(event) => handleSearchResultKeyDown(event, result)}
                  role="button"
                  tabIndex={0}
                  aria-current={result.conversationId === activeConversationId ? 'page' : undefined}
                  aria-label="Open this matching chat and jump to the referenced result"
                  title="Open this matching chat and jump to the referenced result."
                >
                  <Search size={14} />
                  <div className="sidebar-item-text">
                    <span className="sidebar-item-title">{result.conversationTitle}</span>
                    <span className="sidebar-search-snippet">{result.snippet}</span>
                    <div className="sidebar-search-meta">
                      <span className="sidebar-search-match-type">
                        {Number.isInteger(result.turnIndex) ? `Turn ${result.turnIndex + 1}` : result.matchType}
                      </span>
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
            <Virtuoso
              className="sidebar-virtuoso"
              style={{ height: '100%' }}
              data={sortedConversations}
              increaseViewportBy={{ top: 300, bottom: 420 }}
              computeItemKey={(index, conversation) => conversation?.id || `${index}`}
              itemContent={(index, conversation) => (
                <div className="sidebar-virtuoso-item">
                  {renderConversationItem(conversation)}
                </div>
              )}
            />
          )}
        </div>

        <div className="sidebar-footer">
          {importFeedback && (
            <div className={`sidebar-feedback ${importFeedback.tone}`}>
              {importFeedback.message}
            </div>
          )}
          <div className="sidebar-footer-row">
            <div className="sidebar-footer-controls">
              <button
                className="sidebar-footer-btn-icon"
                onClick={handleExportAll}
                disabled={conversations.length === 0}
                aria-label="Export every saved chat in this browser profile as JSON"
                title="Export every saved chat in this browser profile as JSON."
                type="button"
              >
                <Download size={15} />
              </button>
              <button
                className="sidebar-footer-btn-icon"
                onClick={() => importInputRef.current?.click()}
                aria-label="Import chats from a JSON export file"
                title="Import chats from a JSON export file."
                type="button"
              >
                <Upload size={15} />
              </button>
              <InfoTip
                content={[
                  'Export saves chats from this browser profile as JSON.',
                  'Import restores chats from a previous JSON export.',
                ]}
                label="Import and export help"
              />
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImport}
            />
          </div>
          <div className="sidebar-settings-row">
            <button className="sidebar-footer-btn" onClick={handleSettings} type="button" aria-label="Open app settings for models, budget, reliability, and performance" title="Open app settings for models, budget, reliability, and performance.">
              <Settings size={16} />
              <span>Settings</span>
            </button>
            <InfoTip
              content={[
                'Settings controls your model roster, providers, budget rules, reliability, and performance.',
                'Changes apply to new turns unless the current workflow says otherwise.',
              ]}
              label="Settings help"
            />
          </div>
        </div>
      </aside>
    </>
  );
}
