import { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import { Menu, Pencil, Check, X, DollarSign, Share2, Command, Settings2, RotateCcw, RefreshCcw, Globe, Trash2, Sun, Moon } from 'lucide-react';
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
const MAX_VISIBLE_TURNS = 8;

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
  const [showAllTurns, setShowAllTurns] = useState(false);
  const headerTitleRef = useRef(null);
  const scrollRef = useRef(null);

  const turns = activeConversation?.turns || [];
  const conversationCostMeta = useMemo(() => (
    activeConversation
      ? computeConversationCostMeta(activeConversation)
      : { totalCost: 0, quality: 'none' }
  ), [activeConversation]);
  const conversationCostLabel = formatCostWithQuality(conversationCostMeta);

  const turnRenderPlan = useMemo(() => {
    if (showAllTurns || turns.length <= MAX_VISIBLE_TURNS + 1) {
      return {
        hiddenCount: 0,
        items: turns.map((turn, index) => ({ turn, index })),
      };
    }
    const first = { turn: turns[0], index: 0 };
    const tail = turns
      .slice(-MAX_VISIBLE_TURNS)
      .map((turn, offset) => ({
        turn,
        index: turns.length - MAX_VISIBLE_TURNS + offset,
      }));
    return {
      hiddenCount: Math.max(0, turns.length - (1 + tail.length)),
      items: [first, ...tail],
    };
  }, [turns, showAllTurns]);

  const hiddenTurnCount = turnRenderPlan.hiddenCount;

  // Close header edit when switching conversations
  useEffect(() => {
    setEditingHeader(false);
    setShowAllTurns(false);
  }, [activeConversation?.id]);

  useEffect(() => {
    if (turns.length > MAX_VISIBLE_TURNS + 1 && debateInProgress) {
      setShowAllTurns(false);
    }
  }, [turns.length, debateInProgress]);

  // Auto-scroll to bottom only when user is already near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 150;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns, debateInProgress]);

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

  const handleHeaderKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveHeaderEdit(); }
    else if (e.key === 'Escape') { setEditingHeader(false); }
  };

  const emitFocusComposer = () => {
    window.dispatchEvent(new Event('consensus:focus-composer'));
  };

  const handleExportReport = () => {
    if (!activeConversation) return;
    exportConversationReport(activeConversation);
  };

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
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
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
    activeConversation,
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

        <div className="main-content" ref={scrollRef}>
          {turns.length === 0 ? (
            <WelcomeScreen onQuickStart={handleQuickStart} />
          ) : (
            <div className="turns-container">
              {hiddenTurnCount > 0 && !showAllTurns && (
                <div className="turn-virtualized-banner">
                  <span>
                    {hiddenTurnCount} older turn{hiddenTurnCount !== 1 ? 's' : ''} compacted automatically.
                  </span>
                  <button
                    className="turn-virtualized-btn"
                    onClick={() => setShowAllTurns(true)}
                    type="button"
                  >
                    Show All Turns
                  </button>
                </div>
              )}
              {turnRenderPlan.items.map(({ turn, index }) => (
                <DebateView
                  key={turn.id || turn.timestamp || index}
                  turn={turn}
                  index={index}
                  isLastTurn={index === turns.length - 1}
                />
              ))}
              {showAllTurns && hiddenTurnCount > 0 && (
                <div className="turn-virtualized-banner">
                  <span>All turns are visible.</span>
                  <button
                    className="turn-virtualized-btn"
                    onClick={jumpToLatest}
                    type="button"
                  >
                    Jump to Latest
                  </button>
                  <button
                    className="turn-virtualized-btn"
                    onClick={() => setShowAllTurns(false)}
                    type="button"
                  >
                    Collapse Older Turns
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <ChatInput />
      </main>

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
