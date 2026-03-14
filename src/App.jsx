import { forwardRef, useCallback, useState, useEffect, useMemo, lazy, Suspense, useRef } from 'react';
import { Menu, Pencil, Check, X, DollarSign, Share2, Command, Settings2, RotateCcw, RefreshCcw, Globe, Trash2, Sun, Moon } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { useDebateActions, useDebateConversations, useDebateSettings, useDebateUi } from './context/DebateContext';
import {
  computeConversationCostMeta,
  formatCostWithQuality,
  getCostQualityDescription,
} from './lib/formatTokens';
import Sidebar from './components/Sidebar';
import ChatInput from './components/ChatInput';
import DebateView from './components/DebateView';
import WelcomeScreen from './components/WelcomeScreen';
import { exportConversationReport } from './lib/reportExport';
import './App.css';

const SettingsModal = lazy(() => import('./components/SettingsModal'));
const CommandPalette = lazy(() => import('./components/CommandPalette'));

const TurnList = forwardRef(function TurnList(props, ref) {
  const { className = '', style, ...rest } = props;
  const nextClassName = className ? `turns-container ${className}` : 'turns-container';
  return <div {...rest} ref={ref} className={nextClassName} style={style} />;
});

function AppContent() {
  const { dispatch, retryLastTurn, retryAllFailed, clearResponseCache } = useDebateActions();
  const { activeConversation, debateInProgress } = useDebateConversations();
  const { themeMode } = useDebateSettings();
  const { webSearchEnabled, showSettings } = useDebateUi();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [headerTitle, setHeaderTitle] = useState('');
  const [headerDesc, setHeaderDesc] = useState('');
  const headerTitleRef = useRef(null);
  const virtuosoRef = useRef(null);

  const turns = activeConversation?.turns || [];
  const conversationCostMeta = useMemo(() => (
    activeConversation
      ? computeConversationCostMeta(activeConversation)
      : { totalCost: 0, quality: 'none' }
  ), [activeConversation]);
  const conversationCostLabel = formatCostWithQuality(conversationCostMeta);

  useEffect(() => {
    setEditingHeader(false);
  }, [activeConversation?.id]);

  const startHeaderEdit = () => {
    if (!activeConversation) return;
    setHeaderTitle(activeConversation.title || '');
    setHeaderDesc(activeConversation.description || '');
    setEditingHeader(true);
    setTimeout(() => headerTitleRef.current?.focus(), 0);
  };

  const saveHeaderEdit = () => {
    if (!activeConversation) return;
    const trimmed = headerTitle.trim();
    if (trimmed) {
      dispatch({
        type: 'SET_CONVERSATION_TITLE',
        payload: { conversationId: activeConversation.id, title: trimmed, source: 'user' },
      });
    }
    dispatch({ type: 'SET_CONVERSATION_DESCRIPTION', payload: { conversationId: activeConversation.id, description: headerDesc.trim() } });
    setEditingHeader(false);
  };

  const handleHeaderKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveHeaderEdit();
    } else if (event.key === 'Escape') {
      setEditingHeader(false);
    }
  };

  const emitFocusComposer = () => {
    window.dispatchEvent(new Event('consensus:focus-composer'));
  };

  const handleExportReport = useCallback(() => {
    if (!activeConversation) return;
    exportConversationReport(activeConversation);
  }, [activeConversation]);

  const toggleTheme = () => {
    dispatch({ type: 'SET_THEME_MODE', payload: themeMode === 'light' ? 'dark' : 'light' });
  };

  const handleQuickStart = ({ mode, prompt }) => {
    if (mode) {
      dispatch({ type: 'SET_CHAT_MODE', payload: mode });
    }
    if (prompt) {
      window.dispatchEvent(new CustomEvent('consensus:prefill-composer', { detail: { prompt } }));
    }
    emitFocusComposer();
  };

  const jumpToLatest = () => {
    if (turns.length === 0) return;
    virtuosoRef.current?.scrollToIndex({ index: turns.length - 1, align: 'end', behavior: 'smooth' });
  };

  const commands = useMemo(() => ([
    {
      id: 'new-chat',
      title: 'New Chat',
      shortcut: 'N',
      icon: <Command size={14} />,
      keywords: 'new chat conversation',
      run: () => dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: null }),
    },
    {
      id: 'focus-composer',
      title: 'Focus Composer',
      shortcut: 'I',
      icon: <Command size={14} />,
      keywords: 'focus input composer',
      run: emitFocusComposer,
    },
    {
      id: 'toggle-settings',
      title: 'Open Settings',
      shortcut: 'S',
      icon: <Settings2 size={14} />,
      keywords: 'settings preferences config',
      run: () => dispatch({ type: 'SET_SHOW_SETTINGS', payload: true }),
    },
    {
      id: 'toggle-search',
      title: webSearchEnabled ? 'Disable Search' : 'Enable Search',
      shortcut: 'W',
      icon: <Globe size={14} />,
      keywords: 'search web toggle',
      run: () => dispatch({ type: 'SET_WEB_SEARCH_ENABLED', payload: !webSearchEnabled }),
    },
    {
      id: 'toggle-theme',
      title: themeMode === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode',
      shortcut: 'T',
      icon: themeMode === 'light' ? <Moon size={14} /> : <Sun size={14} />,
      keywords: 'theme appearance dark light mode',
      run: toggleTheme,
    },
    {
      id: 'retry-last',
      title: 'Retry Last Turn',
      shortcut: 'R',
      icon: <RotateCcw size={14} />,
      keywords: 'retry rerun last',
      run: () => retryLastTurn?.({ forceRefresh: false }),
    },
    {
      id: 'retry-failed',
      title: 'Retry All Failed',
      shortcut: 'Shift+R',
      icon: <RefreshCcw size={14} />,
      keywords: 'retry failed streams',
      run: () => retryAllFailed?.({ forceRefresh: false }),
    },
    {
      id: 'clear-cache',
      title: 'Clear Response Cache',
      shortcut: 'C',
      icon: <Trash2 size={14} />,
      keywords: 'cache clear memory',
      run: () => clearResponseCache?.(),
    },
    {
      id: 'share-report',
      title: 'Export Report',
      shortcut: 'E',
      icon: <Share2 size={14} />,
      keywords: 'export markdown report',
      run: handleExportReport,
    },
  ].filter((item) => Boolean(item.run))), [
    dispatch,
    themeMode,
    webSearchEnabled,
    retryLastTurn,
    retryAllFailed,
    clearResponseCache,
    handleExportReport,
  ]);

  useEffect(() => {
    const isTypingTarget = (target) => {
      if (!target || !(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || target.isContentEditable;
    };
    const onKeyDown = (event) => {
      const key = String(event.key || '').toLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && key === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (event.key === '/' && !modifier && !isTypingTarget(event.target)) {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app-layout">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="main-area">
        <header className="main-header">
          <button
            className="menu-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu size={20} />
          </button>
          {editingHeader ? (
            <div className="main-header-edit">
              <input
                ref={headerTitleRef}
                className="main-header-edit-input main-header-edit-title"
                value={headerTitle}
                onChange={e => setHeaderTitle(e.target.value)}
                onKeyDown={handleHeaderKeyDown}
                placeholder="Title"
              />
              <input
                className="main-header-edit-input main-header-edit-desc"
                value={headerDesc}
                onChange={e => setHeaderDesc(e.target.value)}
                onKeyDown={handleHeaderKeyDown}
                placeholder="Short description (optional)"
              />
              <button className="main-header-edit-btn save" onClick={saveHeaderEdit} title="Save">
                <Check size={14} />
              </button>
              <button className="main-header-edit-btn cancel" onClick={() => setEditingHeader(false)} title="Cancel">
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="main-header-title-group" onClick={activeConversation ? startHeaderEdit : undefined}>
              <h1 className="main-title">
                {activeConversation?.title || 'New Chat'}
              </h1>
              {activeConversation?.description && (
                <span className="main-description">{activeConversation.description}</span>
              )}
              {activeConversation && (
                <Pencil size={12} className="main-header-edit-icon" />
              )}
            </div>
          )}
          {activeConversation && conversationCostLabel && (
            <div
              className={`main-header-cost ${conversationCostMeta.quality !== 'exact' ? 'uncertain' : ''}`}
              title={getCostQualityDescription(conversationCostMeta.quality)}
            >
              <DollarSign size={12} />
              <span>{conversationCostLabel}</span>
            </div>
          )}
          <button
            className="main-header-theme"
            onClick={toggleTheme}
            title={themeMode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            aria-label={themeMode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {themeMode === 'light' ? <Moon size={14} /> : <Sun size={14} />}
          </button>
          {activeConversation && (
            <button
              className="main-header-share"
              onClick={handleExportReport}
              title="Export report"
            >
              <Share2 size={13} />
              <span>Export</span>
            </button>
          )}
        </header>

        <div className="chat-window-shell">
          <div className="chat-content-shell">
            <div className="main-content">
              {turns.length === 0 ? (
                <WelcomeScreen onQuickStart={handleQuickStart} />
              ) : (
                <Virtuoso
                  ref={virtuosoRef}
                  className="turns-virtuoso"
                  style={{ height: '100%' }}
                  data={turns}
                  increaseViewportBy={{ top: 600, bottom: 1200 }}
                  computeItemKey={(index, turn) => turn.id || turn.timestamp || index}
                  followOutput={(isAtBottom) => (isAtBottom && debateInProgress ? 'smooth' : false)}
                  components={{ List: TurnList }}
                  itemContent={(index, turn) => (
                    <div className="turns-virtuoso-item">
                      <DebateView
                        turn={turn}
                        index={index}
                        isLastTurn={index === turns.length - 1}
                      />
                    </div>
                  )}
                />
              )}
            </div>

            <div id="chat-window-overlay-root" className="chat-window-overlay-root" />
          </div>

          <ChatInput />
        </div>
      </main>

      {turns.length > 0 && (
        <button className="jump-latest-btn" onClick={jumpToLatest} type="button">
          Jump to Latest
        </button>
      )}

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open={commandPaletteOpen}
            commands={commands}
            onClose={() => setCommandPaletteOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
