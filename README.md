# Consensus

A React application with an optional Node proxy that can route requests to OpenRouter, Anthropic, OpenAI, and Gemini while preserving the same debate workflow.

## Features

### 🎭 Query Modes
- **Debate Mode**: Query multiple AI models simultaneously, engage in multi-round debates with convergence checking, and receive a synthesized final answer
- **Ensemble Mode**: Run parallel responses, analyze agreement, and synthesize a vote-weighted answer
- **Parallel Mode**: Run independent model responses only (no debate rounds or synthesis)

### 💬 Advanced Chat Features
- **Multi-Round Debates**: Models debate across multiple rounds until convergence or max rounds
- **Convergence Detection**: Automatic checking when models reach consensus
- **Web Search Integration**: Optional web search to enhance responses with current information
- **File Attachments**: Upload images, PDFs, Excel, Word documents, and text files
- **Auto-Generated Titles**: Conversations automatically get descriptive titles

### 🔄 Flexible Controls
- **Retry Capabilities**: Retry synthesis, individual rounds, or specific model responses
- **Edit Messages**: Edit and resubmit your last message
- **Copy Anywhere**: One-click copy buttons on all content (responses, reasoning, synthesis, convergence analysis)

### 📊 Transparency & Analytics
- **Token Usage**: Real-time token counts for all responses
- **Cost Tracking**: Per-response, per-round, and total debate costs
- **Reasoning Visibility**: View extended thinking/reasoning from models that support it
- **Debate Internals**: Detailed view of debate rounds, convergence checks, model statistics, and costs
- **Response Timing**: Duration tracking for all API calls

### 🎨 Premium UI/UX
- **Dark Mode**: Rich dark theme with glassmorphic design
- **Thread View**: Alternative conversation-style view for debates
- **Streaming Responses**: Real-time streaming of all model responses
- **Smart Auto-Scroll**: Auto-scrolls during streaming without hijacking user control

## Technology Stack

- **Framework**: React with Vite
- **Language**: JavaScript (ES6+)
- **Styling**: Vanilla CSS with custom properties
- **Icons**: Lucide React
- **Markdown**: react-markdown with remark-gfm
- **State**: React Context + Hooks

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- API keys for the providers you want to use

### Installation

1. Clone the repository:
```bash
git clone https://github.com/JBake47/openrouter-debate-app.git
cd openrouter-debate-app
```

2. Install dependencies:
```bash
npm install
```

### Updating an Existing Clone (Other Computers)

`npm install` only updates dependencies. It does not pull new code changes.

Use this sequence to sync your local copy with GitHub:

```bash
git fetch origin
git checkout master
git pull --ff-only origin master
npm ci
```

Optional checks:

```bash
git rev-parse --short HEAD
npm test
npm run build
```

If you have local uncommitted work first:

```bash
git stash push -u -m "temp before sync"
git pull --ff-only origin master
git stash pop
```

3. Configure server environment variables (example in `.env.example`).
   - Recommended: set provider API keys in `.env` and run the backend so keys stay off the client.
   - Optional: you can also add an OpenRouter override key in the in-app **Settings** modal (stored in the browser).

4. Start both backend and frontend together:
```bash
npm run dev:all
```

5. Open your browser to `http://localhost:5173`

Alternative (separate terminals):
```bash
npm run server
npm run dev
```

### Build for Production

```bash
npm run build
npm run preview
```

## Configuration

### Model Selection
- Configure debate models in Settings (default: Claude 3 Opus, Gemini 2.0 Flash, Llama 3 70B)
- Configure synthesis model (default: GPT-4o)
- Prefix direct providers with `anthropic:`, `openai:`, or `gemini:` (e.g. `anthropic:claude-3.7-sonnet`)
- Unprefixed model IDs route through OpenRouter
- The model picker only shows providers that have server-side keys configured

### Debate Settings
- Max rounds: Control debate depth
- Convergence model: Choose which model checks for consensus

## Architecture

### Backend Proxy (Recommended)
Use `server/index.js` to keep API keys off the client. Configure provider keys via environment variables.

### Data Storage
- Conversation history stored in browser localStorage
- Optional OpenRouter override key stored in localStorage
- Efficient context management for large conversations

### Debate Engine
1. User submits a prompt
2. Prompt sent to multiple models in parallel
3. Models engage in multi-round debate (optional)
4. Convergence checking after each round
5. Final synthesis combining all perspectives

## Project Structure

```
src/
├── components/        # React components
│   ├── ChatInput.jsx  # Input area with mode toggle
│   ├── DebateView.jsx # Main debate/response display
│   ├── ModelCard.jsx  # Individual model response cards
│   ├── SynthesisView.jsx # Final synthesized answer
│   └── ...
├── context/          # React Context providers
│   └── DebateContext.jsx # Main state management
├── lib/              # Utilities and API clients
│   ├── openrouter.js # OpenRouter API client
│   ├── debateEngine.js # Debate orchestration
│   └── ...
└── theme.css         # Global styles and variables
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

All rights reserved.

## Acknowledgments

- Built with [OpenRouter](https://openrouter.ai) for unified LLM API access
- Icons by [Lucide](https://lucide.dev)
- Markdown rendering by [react-markdown](https://github.com/remarkjs/react-markdown)

## Support

For issues or questions, please [open an issue](https://github.com/JBake47/openrouter-debate-app/issues) on GitHub.
