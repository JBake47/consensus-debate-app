import { Cpu, RotateCcw, Sparkles, ArrowRight } from 'lucide-react';
import './WelcomeScreen.css';

const QUICK_STARTS = [
  {
    id: 'debate',
    mode: 'debate',
    title: 'Debate',
    description: 'Run rebuttals and convergence checks for harder questions.',
    prompt: 'Debate whether startup teams should optimize for profitability or growth in 2026.',
    icon: <RotateCcw size={16} />,
  },
  {
    id: 'direct',
    mode: 'direct',
    title: 'Ensemble',
    description: 'Get one synthesized answer when you want speed and clarity.',
    prompt: 'Give me the clearest explanation of retrieval-augmented generation for a product manager.',
    icon: <Sparkles size={16} />,
  },
  {
    id: 'parallel',
    mode: 'parallel',
    title: 'Parallel',
    description: 'See separate answers from multiple models side by side.',
    prompt: 'Compare the tradeoffs of local-first vs cloud-first note taking apps.',
    icon: <Cpu size={16} />,
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
          Compare multiple AI models three ways: run them in parallel, get one ensemble answer, or hold a debate.
        </p>

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
