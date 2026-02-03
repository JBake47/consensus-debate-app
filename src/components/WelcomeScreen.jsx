import { Cpu, RotateCcw, Sparkles, ArrowRight } from 'lucide-react';
import './WelcomeScreen.css';

export default function WelcomeScreen() {
  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <div className="welcome-icon">
          <img src="/consensus.svg" alt="Consensus logo" />
        </div>
        <h1 className="welcome-title">Consensus</h1>
        <p className="welcome-subtitle">
          Compare multiple AI models in three ways: parallel responses, ensemble synthesis, or multi-round debate.
        </p>

        <div className="welcome-steps">
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <ArrowRight size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Choose a Mode</strong>
              <span>Debate, Ensemble, or Parallel</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <Cpu size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Parallel Responses</strong>
              <span>Independent answers from multiple models</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <Sparkles size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Ensemble Synthesis</strong>
              <span>Weighted consensus answer based on agreement</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <RotateCcw size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Multi-Round Debate</strong>
              <span>Optional rebuttals and convergence checks</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
