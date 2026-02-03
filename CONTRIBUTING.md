# Contributing to Consensus

Thank you for your interest in contributing to Consensus! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Assume good intentions

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue with:

- **Clear title** describing the problem
- **Steps to reproduce** the issue
- **Expected behavior** vs actual behavior
- **Screenshots** if applicable
- **Environment details**: Browser, OS, Node version

### Suggesting Features

Feature requests are welcome! Please:

- Check existing issues to avoid duplicates
- Clearly describe the feature and its use case
- Explain why this would be valuable to users
- Consider implementation complexity

### Pull Requests

1. **Fork the repository** and create your branch from `master`
2. **Make your changes** following the code style guidelines below
3. **Test your changes** thoroughly
4. **Update documentation** if needed (README, comments, etc.)
5. **Commit with clear messages** following the commit message format
6. **Open a pull request** with a clear description

## Development Setup

1. Fork and clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/openrouter-debate-app.git
cd openrouter-debate-app
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env.local` file (optional):
```bash
cp .env.example .env.local
# Add your OpenRouter API key for testing
```

4. Start the development server:
```bash
npm run dev
```

5. Build to verify everything compiles:
```bash
npm run build
```

## Code Style Guidelines

### JavaScript/React

- Use **functional components** with hooks
- Use **ES6+ features** (arrow functions, destructuring, etc.)
- Keep components **focused and small** (single responsibility)
- Use **descriptive variable names**
- Add **comments** for complex logic
- Avoid over-engineering - keep it simple

### CSS

- Use **CSS custom properties** (variables) defined in `src/theme.css`
- Follow **BEM-like naming** for component-specific styles
- Keep styles **scoped to components** (use component-specific CSS files)
- Maintain **consistent spacing** using CSS variables (--space-sm, --space-md, etc.)
- Use **transitions** for smooth interactions

### File Organization

```
src/
├── components/       # React components (one per file)
│   ├── Component.jsx
│   └── Component.css
├── context/          # React Context providers
├── lib/              # Utilities and helpers
└── theme.css         # Global styles and CSS variables
```

## Commit Message Format

Follow this format for clear commit history:

```
<type>: <short description>

<detailed description if needed>

Co-Authored-By: Your Name <your.email@example.com>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style/formatting (no logic changes)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding tests
- `chore`: Maintenance tasks

**Examples:**
```
feat: Add export conversation to JSON feature

Allow users to export their conversation history as JSON files
for backup and portability.
```

```
fix: Prevent auto-scroll from hijacking user scrolling

Auto-scroll now only triggers when user is near the bottom,
preserving manual scroll position during streaming.
```

## Testing

Before submitting a PR:

1. **Manual testing**: Test your changes in the browser
2. **Build verification**: Run `npm run build` to ensure no errors
3. **Cross-browser**: Test in Chrome/Edge and Firefox if possible
4. **Responsive**: Check mobile/tablet viewports
5. **Error cases**: Test error scenarios and edge cases

## Architecture Guidelines

### Client-Side Only
- All API calls go directly to OpenRouter
- No backend required
- Use localStorage for persistence

### State Management
- Use React Context for global state
- Use local useState for component-specific state
- Keep state as close to where it's used as possible

### Performance
- Avoid unnecessary re-renders (use memo/callback when needed)
- Stream responses for better UX
- Lazy load heavy components if needed

### Error Handling
- Always handle API failures gracefully
- Show user-friendly error messages
- Don't crash the app on errors

## Project-Specific Notes

### Debate Engine
- The debate engine orchestrates multi-round debates between models
- Convergence checking determines when models agree
- Synthesis combines perspectives into a final answer

### Model Integration
- All model interactions go through `src/lib/openrouter.js`
- Support for streaming and non-streaming responses
- Cost tracking for all API calls

### UI Components
- `DebateView`: Main container for debate rounds
- `ModelCard`: Individual model response display
- `SynthesisView`: Final synthesized answer with debate internals
- `ChatInput`: User input with mode toggle and file attachments

## Questions?

If you have questions or need help:

- Open an issue with the "question" label
- Review existing issues and PRs for examples
- Check the README and code comments

## License

By contributing, you agree that your contributions will be subject to the same license as the project.

---

Thank you for contributing to make this project better! 🚀
