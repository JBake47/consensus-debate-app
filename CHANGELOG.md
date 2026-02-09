# Changelog

All notable changes to Consensus will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

## [0.3.14] - 2026-02-09

### Changed
- User message actions now render before the `You` label and timestamp in the right-aligned user header
- User avatar now renders on the far right edge of each user message row

## [0.3.13] - 2026-02-09

### Added
- Configurable fallback model pricing for cost estimation via `VITE_MODEL_PRICING_FALLBACKS` and browser `localStorage` (`model_pricing_fallbacks`)
- Cost-quality metadata and formatting utilities to distinguish exact vs estimated vs partial vs unknown cost values

### Changed
- User prompt bubble alignment and sizing now match conventional chat UX by anchoring user messages to the right side
- Cost readouts now include quality indicators across conversation, turn, round, model, synthesis, and ensemble views
- Cost aggregation now consistently includes convergence checks, web-search runs, ensemble analysis, and synthesis phases

### Fixed
- Usage and cost numeric normalization to prevent string-math inaccuracies in token and cost aggregation
- Convergence and web-search usage capture coverage across debate and retry paths for more complete accounting
- Anthropic usage handling on the server now preserves cost when available and computes token totals safely

## [0.3.12] - 2026-02-09

### Added
- Conditional later-round web-search refresh in debate flows, triggered by weak evidence quality or unresolved factual disagreement signals
- One-refresh cap for later-round search updates to bound cost and latency impact

### Changed
- Rebuttal round prompts now include refreshed web-search context when available
- Debate retry paths (`retryRound` and `retryStream`) now use the same later-round search refresh behavior as normal debate execution

## [0.3.11] - 2026-02-07

### Added
- Per-model retry controls in thread view so individual responses can be retried outside card view

### Changed
- Individual model retry is now available for all non-streaming terminal states

### Fixed
- Cancel now marks in-flight stream entries as `Cancelled`, making them immediately retryable
- Individual model retry flow is now consistent across Ensemble, Debate, and Parallel modes

## [0.3.10] - 2026-02-06

### Added
- Stream stall watchdog for chat streaming requests; stalled runs now auto-cancel with a retryable error
- Optional `VITE_STREAM_STALL_TIMEOUT_MS` setting to tune stream stall timeout behavior

### Changed
- Parallel mode now allows per-model retry while keeping round-level retry disabled

### Fixed
- Search fallback detection is now fully gated to search-enabled runs so normal non-search runs do not enter search fallback logic
- Parallel single-model retries no longer trigger debate/synthesis continuation paths

## [0.3.9] - 2026-02-06

### Added
- Provider-native web search wiring for OpenRouter, Anthropic, OpenAI, and Gemini routes via a shared `nativeWebSearch` request flag
- Search evidence telemetry on model responses, including source count, verification state, and fallback reason in card and thread views
- Strict web search verification setting in Settings to block unverified search-enabled first-round outputs

### Changed
- Search-enabled prompts now explicitly require source URLs and publication date/timestamp evidence
- First-round web search flow now auto-falls back to legacy web-search context when native tool calls fail or when evidence is missing/stale
- Preset editing UX now distinguishes preset-save vs settings-save more clearly, with improved details layout

### Fixed
- Search-enabled retries now preserve verification metadata and strict-mode enforcement paths
- Preset details formatting and placeholder rendering for missing values

## [0.3.8] - 2026-02-05

### Added
- Server-side API access controls for localhost-only mode with optional token-auth remote access
- Configurable server bind host and trust-proxy toggle for deployment networking

### Changed
- Debate synthesis now incorporates content from all completed rounds instead of only the final round
- Retry and edit flows now preserve per-turn focused mode and web search settings
- Settings model ID normalization now consistently maps provider prefixes for model, synthesis, convergence, and web search fields
- `/api/models/search` now validates and clamps `limit` and `offset` query parameters

### Fixed
- Cancellations now mark in-progress synthesis and ensemble analysis as cancelled error states
- Convergence and ensemble vote JSON parsing now more reliably extracts valid nested objects

## [0.3.7] - 2026-02-03

### Added
- Inline delete confirmation for conversations in the sidebar

### Changed
- Settings providers now auto-resolve to enabled providers and coerce OpenRouter model IDs when switching

## [0.3.6] - 2026-02-03

### Added
- Richer settings presets with details and extra model selectors

### Changed
- Settings layout adjustments for presets, debate models, and max rounds placement
- Welcome screen copy updated for Debate, Ensemble, and Parallel modes
- Default header label updated to "New Chat"
- Ensemble placeholder text updated for synthesis

## [0.3.5] - 2026-02-03

### Added
- Model presets with custom names for quick model lineup switching
- Provider-filtered model browse list and datalist suggestions
- Backend health endpoint for provider status (`/api/health`)

### Changed
- Increased default Anthropic max tokens to 64,000
- Improved Settings model controls layout and dropdown readability

## [0.3.4] - 2026-02-03

### Added
- Parallel mode for independent, no-synthesis multi-model responses
- Mode selector dropdown with icons
- Consensus logo and favicon

### Changed
- App name updated to Consensus across UI and metadata

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

[Unreleased]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.14...HEAD
[0.3.14]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/JBake47/openrouter-debate-app/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/JBake47/openrouter-debate-app/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JBake47/openrouter-debate-app/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JBake47/openrouter-debate-app/releases/tag/v0.1.0
