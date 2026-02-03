# Project: Consensus
**Mission**: Build a client-side React application that allows users to prompt multiple AI models via OpenRouter, visualize their individual responses, and synthesizes a final "Debate" answer.

## 1. Technology Stack
- **Framework**: React (Vite)
- **Language**: JavaScript (ES6+)
- **Styling**: Vanilla CSS (CSS Modules preferred for component isolation, or a single `index.css` with well-structured variables).
- **Icons**: `lucide-react`
- **Markdown Rendering**: `react-markdown` with `remark-gfm`
- **State Management**: React Context + Hooks (`useDebate`, `useOpenRouter`).

## 2. Core Architecture (Client-Side Only)
 The app MUST NOT require a backend. All API calls go directly to `https://openrouter.ai/api/v1`.

### 2.1 Configuration & Security
- **API Key**: Store in `localStorage`. Prompt user on first load if missing.
- **Context**: "Infinite" context is simulated by efficiently managing the message history sent to the large-context models supported by OpenRouter (e.g., Gemini 1.5, Claude 3 Opus).

### 2.2 The "Debate" Engine
The core logic resides in a dedicated hook/class that manages the lifecycle of a prompt:
1.  **User Input**: User sends a prompt.
2.  **Orchestration**: The prompt is sent in parallel to 3 distinct models (user-configurable, default to a mix like: `anthropic/claude-3-opus`, `google/gemini-2.0-flash-exp`, `meta-llama/llama-3-70b-instruct`).
3.  **Streaming**: Response streams are captured and displayed in real-time in the UI as "Thought Streams".
4.  **Synthesis**: Once all streams complete, the combined outputs are sent to a "Synthesizer" model (e.g., `openai/gpt-4o` or `anthropic/claude-3.5-sonnet`) with a system prompt effectively saying:
    > "Review the following perspectives on the user's query. Synthesize the best answer, resolving conflicts and providing a comprehensive conclusion."
5.  **Result**: The final synthesized answer is displayed prominently.

## 3. UI/UX Design Requirements
**Theme**: "Premium Intelligence"
- **Background**: Deep, rich dark mode (e.g., `#0a0a0a`) with subtle animated gradients or mesh gradients.
- **Glassmorphism**: Panels and chat bubbles should use semi-transparent backgrounds with backdrop-blur.
- **Typography**: Inter (Google Fonts) or system-ui. Clean, legible, high contrast.
- **Animations**: Smooth transitions for the debate streams appearing/collapsing.
- **Layout**:
    -   **Sidebar**: History (stored locally), Settings (API Key, Model Selection).
    -   **Main Area**: Chat Interface.
    -   **Debate View**: visible "Cards" for each model that can be expanded/collapsed, followed by the main synthesis.

## 4. Implementation Steps for Claude Code

### Step 1: Project Setup
- Initialize Vite React project.
- Install dependencies: `lucide-react`, `react-markdown`.
- Setup `src/theme.css` with CSS variables for colors, spacings, and blurs.

### Step 2: OpenRouter Client
- Create `src/lib/openrouter.js`.
- Implement `streamChat({ model, messages, apiKey, onChunk })`.
- Handle error states (invalid key, rate limits).

### Step 3: Global State
- Create `DebateContext` to track:
    - `apiKey`
    - `selectedModels` (Array of model IDs)
    - `synthesizerModel` (Model ID)
    - `chatHistory`

### Step 4: UI Components
- **`SettingsModal`**: For inputting API Key.
- **`ModelCard`**: Small card showing a model's name, icon, and streaming output (auto-scrolls).
- **`SynthesisView`**: The "Final Answer" component.
- **`ChatInput`**: Styled textarea with "Debate" button.

### Step 5: The "Infinite" Logic
- Ensure that for the Synthesizer step, the prompt includes the *entire* context of the debate streams, leveraging the large context window.

## 5. Development Guidelines
- **No Placeholders**: Implement actual logic.
- **Error Handling**: Gracefully handle API failures from one model without killing the whole debate (just mark that model as failed).
- **Code Style**: Functional React components, clean hooks, descriptive variable names.
