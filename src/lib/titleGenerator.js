import { chatCompletion } from './openrouter.js';

const TITLE_MODEL = 'google/gemini-2.0-flash-001';
const TITLE_MAX_CHARS = 80;
const TITLE_MAX_WORDS = 12;
const DESCRIPTION_MAX_CHARS = 200;

const SMALL_TITLE_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'via',
  'vs',
  'with',
]);

const CANONICAL_TITLE_WORDS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['apis', 'APIs'],
  ['cpu', 'CPU'],
  ['cpus', 'CPUs'],
  ['gpu', 'GPU'],
  ['gpus', 'GPUs'],
  ['llm', 'LLM'],
  ['llms', 'LLMs'],
  ['pdf', 'PDF'],
  ['pdfs', 'PDFs'],
  ['ram', 'RAM'],
  ['rtx', 'RTX'],
  ['ssd', 'SSD'],
  ['ssds', 'SSDs'],
  ['ui', 'UI'],
  ['ux', 'UX'],
  ['4k', '4K'],
  ['8k', '8K'],
  ['3d', '3D'],
]);

const TITLE_SYSTEM_PROMPT = `Generate a concise sidebar title and short description for a chat conversation.
Return ONLY valid JSON in this exact format (no markdown, no code fences):
{"title": "short title", "description": "One-sentence summary under 120 characters"}

Rules for the title:
- Prefer 3-6 words when possible, with an absolute max of 8 words.
- Use a compact topic label, not a full question or sentence.
- Remove filler like "How do I", "Can you", "Please", "What are the best", or "Do you think".
- Keep important specifics such as products, brands, symptoms, constraints, or price limits.
- Use title case.
- Do not use quotation marks.

Examples:
{"title":"Laptop for Local LLM Work","description":"Choosing a laptop for running local language models."}
{"title":"Drug Interaction: Sertraline and Ibuprofen","description":"Checking whether those medications interact."}
{"title":"Noise-Cancelling Headphones Under $200","description":"Comparing headphone options within a budget cap."}`;

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripWrappedQuotes(text) {
  return text.replace(/^[`"'([{<\s]+|[`"')\]}>.\s!?]+$/g, '');
}

function cleanSourceText(text) {
  const normalized = normalizeWhitespace(
    String(text || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .join(' ')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[`*_#]+/g, ' ')
  );
  return stripWrappedQuotes(normalized);
}

function replaceLeadingPattern(text, pattern, replacement) {
  const next = text.replace(pattern, replacement);
  return normalizeWhitespace(next);
}

function applyTitleTransforms(text) {
  let next = cleanSourceText(text);
  if (!next) return '';

  next = replaceLeadingPattern(next, /^title:\s*/i, '');
  next = replaceLeadingPattern(next, /^(?:chat|conversation|question)\s+about\s+/i, '');
  next = replaceLeadingPattern(next, /^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i, '');
  next = replaceLeadingPattern(next, /^please\s+/i, '');
  next = replaceLeadingPattern(next, /^(?:help\s+me|i\s+need\s+help\s+with)\s+/i, '');
  next = replaceLeadingPattern(next, /^(?:how\s+do\s+i|how\s+can\s+i|how\s+should\s+i)\s+/i, 'How to ');
  next = replaceLeadingPattern(next, /^(?:what(?:'s| is)|what\s+are)\s+the\s+best\s+/i, 'Best ');
  next = replaceLeadingPattern(next, /^which\s+(.+?)\s+should\s+i\s+(?:buy|get|choose|pick|use)(.*)$/i, '$1$2');
  next = replaceLeadingPattern(next, /^what\s+percentage(?:\s+of)?\s+/i, 'Percentage of ');
  next = replaceLeadingPattern(next, /^(?:is|are)\s+there\s+(?:a|an)?\s*/i, '');
  next = replaceLeadingPattern(next, /^do\s+you\s+think\s+/i, '');
  next = replaceLeadingPattern(next, /^i\s+need\s+to\s+/i, '');
  next = replaceLeadingPattern(next, /^i\s+want\s+to\s+/i, '');
  next = replaceLeadingPattern(next, /^i'?m\s+trying\s+to\s+/i, '');
  next = replaceLeadingPattern(next, /^(?:can|could|would)\s+you\s+summari[sz]e\s+/i, 'Summary of ');
  next = replaceLeadingPattern(next, /^summari[sz]e\s+(?:this|these)\s+/i, 'Summary of ');
  next = next.replace(/[?!]+$/g, '');
  next = next.replace(/\s*[:;-]\s*$/g, '');
  next = next.replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '');
  return normalizeWhitespace(next);
}

function formatTitleWord(word, index, total) {
  if (!word) return word;
  const lower = word.toLowerCase();
  if (CANONICAL_TITLE_WORDS.has(lower)) {
    return CANONICAL_TITLE_WORDS.get(lower);
  }
  if (/^[A-Z0-9]{2,}$/.test(word) || /[A-Z].+[A-Z]/.test(word)) {
    return word;
  }
  if (index > 0 && index < total - 1 && SMALL_TITLE_WORDS.has(lower)) {
    return lower;
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function toHeadlineCase(text) {
  const tokens = normalizeWhitespace(text).split(' ').filter(Boolean);
  return tokens.map((token, index) => {
    const segments = token.split('-');
    const formattedSegments = segments.map((segment) => formatTitleWord(segment, index, tokens.length));
    return formattedSegments.join('-');
  }).join(' ');
}

function clampTitle(text) {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  const limitedWords = words.slice(0, TITLE_MAX_WORDS).join(' ');
  if (limitedWords.length <= TITLE_MAX_CHARS) {
    return limitedWords;
  }
  const boundary = limitedWords.lastIndexOf(' ', TITLE_MAX_CHARS);
  return boundary >= 12
    ? limitedWords.slice(0, boundary).trim()
    : limitedWords.slice(0, TITLE_MAX_CHARS).trim();
}

function normalizeDescription(description) {
  return stripWrappedQuotes(cleanSourceText(description)).slice(0, DESCRIPTION_MAX_CHARS);
}

export function createSeedTitle(prompt) {
  const transformed = applyTitleTransforms(prompt);
  if (!transformed) return 'New Chat';
  return clampTitle(toHeadlineCase(transformed));
}

export function normalizeGeneratedTitle(title, userPrompt = '') {
  const candidate = cleanSourceText(title) || cleanSourceText(userPrompt);
  if (!candidate) return '';
  const transformed = applyTitleTransforms(candidate);
  if (!transformed) {
    return createSeedTitle(userPrompt);
  }
  return clampTitle(toHeadlineCase(transformed));
}

/**
 * Generate a short title and description for a conversation based on the user prompt and synthesis.
 * Uses a fast model to keep cost/latency low.
 * Falls back to a deterministic title derived from the prompt on failure.
 */
export async function generateTitle({ userPrompt, synthesisContent, apiKey, signal }) {
  const truncatedPrompt = cleanSourceText(userPrompt).slice(0, 600);
  const truncatedSynthesis = cleanSourceText(synthesisContent).slice(0, 1400);
  const seedTitle = createSeedTitle(userPrompt);

  const userMessage = truncatedSynthesis
    ? `User prompt: "${truncatedPrompt}"\nSeed title candidate: "${seedTitle}"\nSynthesized answer: "${truncatedSynthesis}"`
    : `User prompt: "${truncatedPrompt}"\nSeed title candidate: "${seedTitle}"`;

  try {
    const { content } = await chatCompletion({
      model: TITLE_MODEL,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      apiKey,
      signal,
    });

    const parsed = parseResponse(content, userPrompt);
    if (parsed) return parsed;
    return fallback(userPrompt);
  } catch {
    return fallback(userPrompt);
  }
}

function parseResponse(text, userPrompt) {
  const parseCandidate = (candidate) => {
    try {
      const parsed = JSON.parse(candidate.trim());
      const title = normalizeGeneratedTitle(parsed.title || '', userPrompt);
      const description = normalizeDescription(parsed.description || '');
      if (title && title.length < 100) {
        return { title, description };
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(text);
  if (direct) return direct;

  const match = String(text || '').match(/\{[\s\S]*?"title"[\s\S]*?\}/);
  if (match) {
    const extracted = parseCandidate(match[0]);
    if (extracted) return extracted;
  }

  const plain = normalizeGeneratedTitle(text, userPrompt);
  if (plain && plain.length < 100) {
    return { title: plain, description: '' };
  }
  return null;
}

function fallback(prompt) {
  return { title: createSeedTitle(prompt), description: '' };
}
