import { Cpu, RotateCcw, Sparkles, ArrowRight } from 'lucide-react';
import './WelcomeScreen.css';

const QUICK_STARTS = [
  {
    id: 'parallel',
    mode: 'parallel',
    title: 'Compare Fast',
    description: 'See separate answers from multiple models side by side.',
    prompt: 'Compare the tradeoffs of local-first vs cloud-first note taking apps.',
    icon: <Cpu size={16} />,
  },
  {
    id: 'direct',
    mode: 'direct',
    title: 'Best Answer',
    description: 'Get one synthesized answer when you want speed and clarity.',
    prompt: 'Give me the clearest explanation of retrieval-augmented generation for a product manager.',
    icon: <Sparkles size={16} />,
  },
  {
    id: 'debate',
    mode: 'debate',
    title: 'Deep Debate',
    description: 'Run rebuttals and convergence checks for harder questions.',
    prompt: 'Debate whether startup teams should optimize for profitability or growth in 2026.',
    icon: <RotateCcw size={16} />,
  },
];

export default function WelcomeScreen({ onQuickStart }) {
  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <div className="welcome-icon">
          <img src="/consensus.svg" alt="Consensus logo" />
        </div>
        <h1 className="welcome-title">Consensus</h1>
        <p className="welcome-subtitle">
          Compare multiple AI models three ways: compare side by side, get one best answer, or run a deeper debate.
        </p>

        <div className="welcome-steps">
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <ArrowRight size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Pick the outcome you want</strong>
              <span>Compare, Best Answer, or Deep Debate</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <Cpu size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Compare</strong>
              <span>Independent answers from multiple models</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <Sparkles size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Best Answer</strong>
              <span>One synthesized answer based on model agreement</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <RotateCcw size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Deep Debate</strong>
              <span>Optional rebuttals and convergence checks</span>
            </div>
          </div>
        </div>

        <div className="welcome-quick-starts">
          {QUICK_STARTS.map((item) => (
            <button
              key={item.id}
              className="welcome-quick-start glass-panel"
              onClick={() => onQuickStart?.({ mode: item.mode, prompt: item.prompt })}
              type="button"
            >
              <span className="welcome-quick-start-icon">{item.icon}</span>
              <span className="welcome-quick-start-copy">
                <strong>{item.title}</strong>
                <span>{item.description}</span>
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
