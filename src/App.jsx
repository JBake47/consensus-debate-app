import { forwardRef, useCallback, useState, useEffect, useMemo, lazy, Suspense, useRef } from 'react';
import { PanelLeft, Pencil, Check, X, DollarSign, Share2, Command, Settings2, RotateCcw, RefreshCcw, Globe, Trash2, Sun, Moon, Sparkles, GitBranchPlus } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { useDebateActions, useDebateConversationList, useDebateConversations, useDebateSettings, useDebateUi } from './context/DebateContext';
import { isTypingShortcutTarget, matchesShortcut } from './lib/keyboardShortcuts';
import { getModelDisplayName } from './lib/openrouter';
import { describeConversationBranch } from './lib/conversationBranching';
import {
  computeConversationCostMeta,
  formatCostWithQuality,
  getCostQualityDescription,
} from './lib/formatTokens';
import Sidebar from './components/Sidebar';
import ChatInput from './components/ChatInput';
import DebateView from './components/DebateView';
import TransferMenuButton from './components/TransferMenuButton';
import WelcomeScreen from './components/WelcomeScreen';
import './App.css';

const SettingsModal = lazy(() => import('./components/SettingsModal'));
const CommandPalette = lazy(() => import('./components/CommandPalette'));

const TurnList = forwardRef(function TurnList(props, ref) {
  const { className = '', style, ...rest } = props;
  const nextClassName = className ? `turns-container ${className}` : 'turns-container';
  return <div {...rest} ref={ref} className={nextClassName} style={style} />;
});

function AppContent() {
  const {
    dispatch,
    retryLastTurn,
    retryAllFailed,
    branchFromSynthesis,
    clearResponseCache,
    applyModelUpgrade,
    enableModelUpgradeAutoSwitch,
    dismissModelUpgrade,
    dismissAllModelUpgrades,
  } = useDebateActions();
  const { activeConversation, debateInProgress } = useDebateConversations();
  const { getConversationById } = useDebateConversationList();
  const {
    themeMode,
    apiKey,
    providerStatus,
    providerStatusState,
    modelUpgradeSuggestions,
  } = useDebateSettings();
  const { webSearchEnabled, showSettings, pendingTurnFocus, conversationStoreStatus } = useDebateUi();
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return true;
    }
    return window.matchMedia('(min-width: 769px)').matches;
  });
  const [editingHeader, setEditingHeader] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [headerTitle, setHeaderTitle] = useState('');
  const [headerDesc, setHeaderDesc] = useState('');
  const [highlightedTurnKey, setHighlightedTurnKey] = useState(null);
  const headerTitleRef = useRef(null);
  const virtuosoRef = useRef(null);
  const highlightedTurnTimeoutRef = useRef(0);

  const turns = activeConversation?.turns || [];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const activeConversationParent = useMemo(() => (
    activeConversation?.parentConversationId
      ? getConversationById(activeConversation.parentConversationId)
      : null
  ), [activeConversation?.parentConversationId, getConversationById]);
  const activeConversationLineage = useMemo(() => (
    describeConversationBranch(
      activeConversation?.branchedFrom,
      activeConversationParent?.title || '',
    )
  ), [activeConversation?.branchedFrom, activeConversationParent?.title]);
  const canBranchFromSynthesis = Boolean(
    activeConversation
    && !debateInProgress
    && lastTurn?.synthesis?.status === 'complete'
  );
  const conversationCostMeta = useMemo(() => (
    activeConversation
      ? computeConversationCostMeta(activeConversation)
      : { totalCost: 0, quality: 'none' }
  ), [activeConversation]);
  const conversationCostLabel = formatCostWithQuality(conversationCostMeta);
  const hasConfiguredProvider = Boolean(String(apiKey || '').trim())
    || Object.values(providerStatus || {}).some(Boolean);
  const providerStateReady = providerStatusState === 'ready';
  const requiresProviderSetup = providerStateReady && !hasConfiguredProvider;
  const primaryUpgradeSuggestion = modelUpgradeSuggestions[0] || null;
  const modelUpgradeBannerMessage = useMemo(() => {
    if (modelUpgradeSuggestions.length === 0) return '';
    if (modelUpgradeSuggestions.length === 1 && primaryUpgradeSuggestion) {
      if (primaryUpgradeSuggestion.isSafe === false) {
        return `${getModelDisplayName(primaryUpgradeSuggestion.suggestedModel)} is available for ${primaryUpgradeSuggestion.roleLabels.join(', ')}, but it is not marked safe for auto-switching. ${primaryUpgradeSuggestion.safetyMessage || ''}`.trim();
      }
      return `${getModelDisplayName(primaryUpgradeSuggestion.suggestedModel)} can replace ${getModelDisplayName(primaryUpgradeSuggestion.currentModel)} for ${primaryUpgradeSuggestion.roleLabels.join(', ')}.`;
    }
    return `${modelUpgradeSuggestions.length} newer model upgrades are available for your current lineup.`;
  }, [modelUpgradeSuggestions, primaryUpgradeSuggestion]);

  useEffect(() => {
    setEditingHeader(false);
  }, [activeConversation?.id]);

  useEffect(() => () => {
    if (highlightedTurnTimeoutRef.current) {
      window.clearTimeout(highlightedTurnTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!pendingTurnFocus || activeConversation?.id !== pendingTurnFocus.conversationId) {
      return undefined;
    }

    const requestedIndex = Number(pendingTurnFocus.turnIndex);
    if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= turns.length) {
      dispatch({ type: 'SET_PENDING_TURN_FOCUS', payload: null });
      return undefined;
    }

    const timer = window.setTimeout(() => {
      virtuosoRef.current?.scrollToIndex({
        index: requestedIndex,
        align: 'center',
        behavior: 'smooth',
      });

      const targetTurn = turns[requestedIndex];
      const targetKey = targetTurn?.id || targetTurn?.timestamp || requestedIndex;
      setHighlightedTurnKey(targetKey);
      dispatch({ type: 'SET_PENDING_TURN_FOCUS', payload: null });

      if (highlightedTurnTimeoutRef.current) {
        window.clearTimeout(highlightedTurnTimeoutRef.current);
      }
      highlightedTurnTimeoutRef.current = window.setTimeout(() => {
        setHighlightedTurnKey(null);
      }, 2600);
    }, 90);

    return () => window.clearTimeout(timer);
  }, [activeConversation?.id, dispatch, pendingTurnFocus, turns]);

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

  const openSettings = useCallback(() => {
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: true });
  }, [dispatch]);
  const openModelUpgradeReview = useCallback((suggestion) => {
    const primaryTarget = Array.isArray(suggestion?.targets) ? suggestion.targets[0] || null : null;
    dispatch({
      type: 'SET_PENDING_SETTINGS_FOCUS',
      payload: {
        pane: 'models',
        targetKey: primaryTarget?.key || '',
      },
    });
    dispatch({ type: 'SET_SHOW_SETTINGS', payload: true });
  }, [dispatch]);

  const handleExportReport = useCallback(async () => {
    if (!activeConversation) return;
    const { exportConversationReport } = await import('./lib/reportExport');
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

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, []);

  const commands = useMemo(() => ([
    {
      id: 'new-chat',
      title: 'New Chat',
      shortcut: 'Alt+N',
      icon: <Command size={14} />,
      keywords: 'new chat conversation',
      run: () => dispatch({ type: 'SET_ACTIVE_CONVERSATION', payload: null }),
    },
    {
      id: 'focus-composer',
      title: 'Focus Composer',
      shortcut: 'Alt+I',
      icon: <Command size={14} />,
      keywords: 'focus input composer',
      run: emitFocusComposer,
    },
    {
      id: 'toggle-settings',
      title: 'Open Settings',
      shortcut: 'Alt+S',
      icon: <Settings2 size={14} />,
      keywords: 'settings preferences config',
      run: openSettings,
    },
    {
      id: 'toggle-search',
      title: webSearchEnabled ? 'Disable Search' : 'Enable Search',
      shortcut: 'Alt+W',
      icon: <Globe size={14} />,
      keywords: 'search web toggle',
      run: () => dispatch({ type: 'SET_WEB_SEARCH_ENABLED', payload: !webSearchEnabled }),
    },
    {
      id: 'toggle-theme',
      title: themeMode === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode',
      shortcut: 'Alt+T',
      icon: themeMode === 'light' ? <Moon size={14} /> : <Sun size={14} />,
      keywords: 'theme appearance dark light mode',
      run: toggleTheme,
    },
    {
      id: 'retry-last',
      title: 'Retry Last Turn',
      shortcut: 'Alt+R',
      icon: <RotateCcw size={14} />,
      keywords: 'retry rerun last',
      run: () => retryLastTurn?.({ forceRefresh: false }),
    },
    {
      id: 'retry-failed',
      title: 'Retry All Failed',
      shortcut: 'Alt+Shift+R',
      icon: <RefreshCcw size={14} />,
      keywords: 'retry failed streams',
      run: () => retryAllFailed?.({ forceRefresh: false }),
    },
    canBranchFromSynthesis && {
      id: 'branch-synthesis',
      title: 'Branch From Latest Synthesized Answer',
      shortcut: 'Alt+B',
      icon: <GitBranchPlus size={14} />,
      keywords: 'branch checkpoint latest synthesis answer continue',
      run: () => branchFromSynthesis?.(),
    },
    {
      id: 'clear-cache',
      title: 'Clear Response Cache',
      shortcut: 'Alt+C',
      icon: <Trash2 size={14} />,
      keywords: 'cache clear memory',
      run: () => clearResponseCache?.(),
    },
    {
      id: 'share-report',
      title: 'Export Report',
      shortcut: 'Alt+E',
      icon: <Share2 size={14} />,
      keywords: 'export markdown report',
      run: handleExportReport,
    },
  ].filter((item) => Boolean(item?.run))), [
    dispatch,
    themeMode,
    webSearchEnabled,
    retryLastTurn,
    retryAllFailed,
    canBranchFromSynthesis,
    branchFromSynthesis,
    clearResponseCache,
    handleExportReport,
    openSettings,
  ]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = String(event.key || '').toLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      const typingTarget = isTypingShortcutTarget(event.target);
      if (modifier && key === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (event.key === '/' && !modifier && !typingTarget) {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (typingTarget) {
        return;
      }
      const matchedCommand = commands.find((command) => matchesShortcut(event, command.shortcut));
      if (matchedCommand) {
        event.preventDefault();
        matchedCommand.run?.();
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commands]);

  const handleHeaderTitleKeyDown = (event) => {
    if (!activeConversation) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startHeaderEdit();
    }
  };

  return (
    <div className={`app-layout ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <Sidebar open={sidebarOpen} />

      <main className="main-area">
        <header className="main-header">
          <button
            className="menu-toggle"
            onClick={toggleSidebar}
            aria-controls="app-sidebar"
            aria-expanded={sidebarOpen}
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            type="button"
            title={sidebarOpen ? 'Hide the chat list and library actions.' : 'Show the chat list, search, import/export, and settings.'}
          >
            <PanelLeft size={18} />
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
                title="Rename this chat. Press Enter to save."
              />
              <input
                className="main-header-edit-input main-header-edit-desc"
                value={headerDesc}
                onChange={e => setHeaderDesc(e.target.value)}
                onKeyDown={handleHeaderKeyDown}
                placeholder="Short description (optional)"
                title="Optional description shown under the chat title."
              />
              <button className="main-header-edit-btn save" onClick={saveHeaderEdit} title="Save the edited title and description.">
                <Check size={14} />
              </button>
              <button className="main-header-edit-btn cancel" onClick={() => setEditingHeader(false)} title="Cancel editing and keep the current title.">
                <X size={14} />
              </button>
            </div>
          ) : (
            <div
              className="main-header-title-group"
              onClick={activeConversation ? startHeaderEdit : undefined}
              onKeyDown={handleHeaderTitleKeyDown}
              role={activeConversation ? 'button' : undefined}
              tabIndex={activeConversation ? 0 : undefined}
              aria-label={activeConversation ? 'Edit chat title and description' : undefined}
              title={activeConversation ? 'Click to rename this chat and add a short description.' : undefined}
            >
              <div className="main-header-copy">
                <div className="main-header-heading">
                  <h1 className="main-title">
                    {activeConversation?.title || 'New Chat'}
                  </h1>
                  {activeConversation && (
                    <Pencil size={12} className="main-header-edit-icon" />
                  )}
                </div>
                {(activeConversation?.description || activeConversationLineage) && (
                  <div className="main-header-meta">
                    {activeConversation?.description && (
                      <span className="main-description">{activeConversation.description}</span>
                    )}
                    {activeConversationLineage && (
                      <>
                        <span
                          className="main-header-lineage-badge"
                          title={activeConversationLineage.tooltip}
                        >
                          <GitBranchPlus size={11} />
                          <span>{activeConversationLineage.badgeLabel}</span>
                        </span>
                        {activeConversationLineage.parentLabel && (
                          <span
                            className="main-header-lineage-caption"
                            title={activeConversationLineage.tooltip}
                          >
                            {activeConversationLineage.caption}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
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
            title={themeMode === 'light'
              ? 'Switch the app to dark mode. You can also change this in Settings > General.'
              : 'Switch the app to light mode. You can also change this in Settings > General.'}
            aria-label={themeMode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {themeMode === 'light' ? <Moon size={14} /> : <Sun size={14} />}
          </button>
          {activeConversation && (
            <TransferMenuButton
              conversation={activeConversation}
              className="main-header-share"
            />
          )}
          {activeConversation && (
            <button
              className="main-header-share"
              onClick={handleExportReport}
              title="Export this chat as a readable report instead of raw conversation JSON."
            >
              <Share2 size={13} />
              <span>Export</span>
            </button>
          )}
        </header>

        <div className="chat-window-shell">
          <div className="chat-content-shell">
            <div className="main-content">
              {modelUpgradeSuggestions.length > 0 && (
                <div className="model-upgrade-banner">
                  <div className="model-upgrade-banner-copy">
                    <strong>
                      {modelUpgradeSuggestions.length === 1 ? 'Newer Model Available' : 'Model Upgrades Available'}
                    </strong>
                    <span>{modelUpgradeBannerMessage}</span>
                  </div>
                  <div className="model-upgrade-banner-actions">
                    {modelUpgradeSuggestions.length === 1 && primaryUpgradeSuggestion && primaryUpgradeSuggestion.isSafe !== false ? (
                      <>
                        <button
                          className="model-upgrade-banner-btn primary"
                          type="button"
                          onClick={() => applyModelUpgrade(primaryUpgradeSuggestion)}
                          title={`Replace ${primaryUpgradeSuggestion.currentModel} with ${primaryUpgradeSuggestion.suggestedModel} for the listed targets.`}
                        >
                          <Sparkles size={13} />
                          <span>Switch</span>
                        </button>
                        <button
                          className="model-upgrade-banner-btn"
                          type="button"
                          onClick={() => enableModelUpgradeAutoSwitch(primaryUpgradeSuggestion)}
                          title={`Always auto-switch future turns from ${primaryUpgradeSuggestion.currentModel} to ${primaryUpgradeSuggestion.suggestedModel} for the listed targets.`}
                        >
                          Always auto-switch
                        </button>
                        <button
                          className="model-upgrade-banner-btn"
                          type="button"
                          onClick={() => dismissModelUpgrade(primaryUpgradeSuggestion)}
                          title="Dismiss this upgrade notice until a different newer version appears."
                        >
                          Dismiss
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="model-upgrade-banner-btn primary"
                          type="button"
                          onClick={() => openModelUpgradeReview(primaryUpgradeSuggestion || modelUpgradeSuggestions[0] || null)}
                          title="Review available model upgrades in Settings > Models."
                        >
                          <Sparkles size={13} />
                          <span>Review</span>
                        </button>
                        <button
                          className="model-upgrade-banner-btn"
                          type="button"
                          onClick={() => dismissAllModelUpgrades(modelUpgradeSuggestions)}
                          title="Dismiss the current upgrade notices until a different newer version appears."
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {turns.length === 0 ? (
                <WelcomeScreen
                  loading={conversationStoreStatus !== 'ready'}
                  requiresProviderSetup={requiresProviderSetup}
                  onOpenSettings={openSettings}
                  onQuickStart={handleQuickStart}
                />
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
                        highlighted={highlightedTurnKey === (turn.id || turn.timestamp || index)}
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
        <button className="jump-latest-btn" onClick={jumpToLatest} type="button" title="Jump to the newest turn in the current chat.">
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
