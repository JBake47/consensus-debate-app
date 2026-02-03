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
          Send a prompt to multiple AI models, watch them debate across rounds, and get a consensus answer from their best insights.
        </p>

        <div className="welcome-steps">
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <ArrowRight size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Ask a Question</strong>
              <span>Type your prompt and hit Debate</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <Cpu size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Models Respond</strong>
              <span>Multiple AI models stream their initial answers</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <RotateCcw size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Multi-Round Debate</strong>
              <span>Models challenge each other and refine positions until they converge</span>
            </div>
          </div>
          <div className="welcome-step glass-panel">
            <div className="welcome-step-icon">
              <Sparkles size={16} />
            </div>
            <div className="welcome-step-text">
              <strong>Synthesis</strong>
              <span>A synthesizer reviews the full debate and produces the best answer</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
