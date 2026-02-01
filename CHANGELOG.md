# Changelog

All notable changes to the OpenRouter Debate App will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CHANGELOG.md to track version history

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

[Unreleased]: https://github.com/JBake47/openrouter-debate-app/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/JBake47/openrouter-debate-app/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JBake47/openrouter-debate-app/releases/tag/v0.1.0
