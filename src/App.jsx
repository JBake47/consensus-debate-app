import { useState, useRef, useEffect } from 'react';
import { Menu, Pencil, Check, X, DollarSign } from 'lucide-react';
import { useDebate } from './context/DebateContext';
import {
  computeConversationCostMeta,
  formatCostWithQuality,
  getCostQualityDescription,
} from './lib/formatTokens';
import Sidebar from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import ChatInput from './components/ChatInput';
import DebateView from './components/DebateView';
import WelcomeScreen from './components/WelcomeScreen';
import './App.css';

function AppContent() {
  const { activeConversation, debateInProgress, dispatch } = useDebate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerTitle, setHeaderTitle] = useState('');
  const [headerDesc, setHeaderDesc] = useState('');
  const headerTitleRef = useRef(null);
  const scrollRef = useRef(null);

  const turns = activeConversation?.turns || [];
  const conversationCostMeta = activeConversation
    ? computeConversationCostMeta(activeConversation)
    : { totalCost: 0, quality: 'none' };
  const conversationCostLabel = formatCostWithQuality(conversationCostMeta);

  // Close header edit when switching conversations
  useEffect(() => {
    setEditingHeader(false);
  }, [activeConversation?.id]);

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
      dispatch({ type: 'SET_CONVERSATION_TITLE', payload: { conversationId: activeConversation.id, title: trimmed } });
    }
    dispatch({ type: 'SET_CONVERSATION_DESCRIPTION', payload: { conversationId: activeConversation.id, description: headerDesc.trim() } });
    setEditingHeader(false);
  };

  const handleHeaderKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveHeaderEdit(); }
    else if (e.key === 'Escape') { setEditingHeader(false); }
  };

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
        </header>

        <div className="main-content" ref={scrollRef}>
          {turns.length === 0 ? (
            <WelcomeScreen />
          ) : (
            <div className="turns-container">
              {turns.map((turn, i) => (
                <DebateView key={turn.id || turn.timestamp || i} turn={turn} index={i} isLastTurn={i === turns.length - 1} />
              ))}
            </div>
          )}
        </div>

        <ChatInput />
      </main>

      <SettingsModal />
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
