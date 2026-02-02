# Changelog

All notable changes to the OpenRouter Debate App will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Backend API proxy with provider routing for Anthropic, OpenAI, Gemini, and OpenRouter
- Provider-prefix model routing (`anthropic:`, `openai:`, `gemini:`) with OpenRouter as default
- `dev:all` script to run server and client together
- Provider-aware model picker that only lists enabled providers

### Changed
- OpenRouter API key is now optional (server-owned keys recommended)
- Frontend now calls the backend proxy for chat and model metadata
- Excel parsing now uses `exceljs` instead of `xlsx`

## [0.3.3] - 2026-02-02

### Added
- PDF canvas viewer with paging/zoom controls
- Warning when selected models do not support image attachments
- OpenRouter model catalog fetch for capability checks

### Changed
- PDF inline limit increased to 40 MB
- Web search requests now include text attachments

### Fixed
- PDF text extraction now uses bundled pdf.js worker (no CDN dependency)
- PDF preview falls back to extracted text when inline data is unavailable

## [0.3.1] - 2026-02-02

### Added
- Cancel edit button and inline "editing" badge in chat input
- Optional "Remember key" setting to persist API key beyond session

### Changed
- Edit flow now defers deleting the last turn until resubmission
- Chat input keys are now stable per turn to avoid UI reuse issues
- Settings modal state now re-syncs from persisted settings on open

### Fixed
- Canceling a debate now marks in-flight round/streams as cancelled instead of leaving them streaming
- Focused mode toggle now applies immediately in debate mode
- Reasoning updates no longer clear streamed content mid-response
- Hook order violation in Settings modal that could blank the app

## [0.3.0] - 2026-02-01

### Added
- **Ensemble Vote Mode** (replaces simple Direct mode):
  - Phase 1: All debate models run independently in parallel
  - Phase 2: Vote analysis produces confidence scores (0-100), outlier detection, agreement/disagreement areas, and model quality weights
  - Phase 3: Streaming synthesis weighted by vote analysis results
  - New `EnsembleResultPanel` component with confidence meter, outlier badges, and expandable details
  - Backward compatible with old single-stream direct turns
  - Full retry support (re-runs vote analysis and synthesis)
- **Focused Mode** for both Debate and Ensemble modes:
  - Toggle for concise, direct responses across all modes
  - Debate mode: sharp, brief rebuttals (half the typical length)
  - Ensemble mode: concise analyses and synthesis
  - Persistent setting stored in localStorage
- **Disagreement Mapping** in debates:
  - New `ConvergencePanel` component showing per-round convergence analysis
  - Displays confidence scores with colored mini-bars
  - Expandable sections for agreement lists and disagreement cards
  - Disagreement cards show per-model positions for each point of contention
- **Confidence Levels** per debate round:
  - 0-100 confidence scores shown under each round step in progress bar
  - Color-coded by level (high/mid/low)
  - Consensus trend mini-chart visualizes confidence progression across rounds
- **Prominent Reasoning** for o1/o3/reasoning models:
  - Auto-detect reasoning models (o1, o3, deepseek-r1, qwq, reasoner)
  - Auto-expand reasoning sections by default for these models
  - Side-by-side layout option: reasoning on left, response on right
  - Layout toggle button to switch between stacked and side-by-side views

### Changed
- Direct mode renamed to "Ensemble" in user interface
- Round label changes to "Focused Analyses" when focused mode is enabled in ensemble
- Focused mode toggle now visible in both Debate and Ensemble modes
- Ensemble cost tracking includes vote analysis phase costs

### Technical
- Added ensemble-specific prompts and focused variants to `debateEngine.js`
- Rewrote `startDirect` to implement 3-phase ensemble flow
- Added `SET_ENSEMBLE_RESULT` and `SET_FOCUSED_MODE` reducer actions
- Created `runEnsembleAnalysisAndSynthesis` helper for vote analysis and synthesis
- Updated all retry functions to support ensemble mode
- Added ensemble CSS variables (`--accent-ensemble`, `--ensemble-confidence-*`)
- Enhanced `ModelCard` with side-by-side reasoning layout
- Updated convergence prompt to request structured JSON with confidence and disagreements

## [0.2.0] - 2026-02-01

### Added
- Chat mode toggle between debate and direct query modes
- Copy-to-clipboard buttons across all content areas
  - LLM responses and reasoning
  - Synthesized answers
  - User messages
  - Web search results
  - Convergence analysis details
- Cost display in debate internals at three levels:
  - Total debate cost
  - Per-round cost
  - Per-stream cost
- Expandable convergence badge with full analysis and raw response
- Repository documentation:
  - Comprehensive README with features and setup instructions
  - CONTRIBUTING.md with guidelines for contributors
  - .env.example for environment variable reference
  - .gitattributes for consistent line endings
- .claude directory to .gitignore

### Changed
- ConvergenceBadge transformed from simple badge to expandable panel
- License changed from MIT to All Rights Reserved
- Direct mode submit button uses blue-green gradient instead of purple

### Fixed
- Auto-scroll behavior to prevent hijacking user scrolling during streaming
- Line ending warnings across platforms with .gitattributes

## [0.1.0] - 2026-01-31

### Added
- Multi-round debate engine with convergence detection
- Dual view modes: Card view and Thread view for debates
- Edit and retry capabilities:
  - Edit last user message
  - Retry last turn
  - Retry individual debate rounds
  - Retry synthesis
- Auto-generated conversation titles with descriptions
- Cost tracking and display:
  - Per-response cost
  - Per-round cost
  - Turn-level cost summaries
- LLM reasoning/thinking visibility for supported models
- Web search integration for enhanced responses
- File attachment support:
  - Images (PNG, JPG, GIF, WebP)
  - PDFs
  - Excel spreadsheets
  - Word documents
  - Text files
- Token usage display for all responses
- Response timing (duration tracking)
- Real-time streaming of model responses
- Smart auto-scroll during streaming
- Dark mode UI with glassmorphic design
- Conversation history sidebar with search
- Settings modal for API key and model configuration
- localStorage-based persistence
- Client-side only architecture (no backend required)

### Core Features
- OpenRouter API integration
- Support for multiple AI models:
  - Anthropic Claude models
  - Google Gemini models
  - Meta Llama models
  - OpenAI GPT models
  - And all other OpenRouter-supported models
- Markdown rendering with syntax highlighting
- Code block copy functionality
- Responsive design for mobile and desktop

[Unreleased]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/JBake47/openrouter-debate-app/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JBake47/openrouter-debate-app/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JBake47/openrouter-debate-app/releases/tag/v0.1.0
