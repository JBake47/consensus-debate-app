import { chatCompletion } from './openrouter';

const TITLE_MODEL = 'google/gemini-2.0-flash-exp';

const TITLE_SYSTEM_PROMPT = `Generate a concise title and short description for this conversation.
Return ONLY valid JSON in this exact format (no markdown, no code fences):
{"title": "5-8 word title", "description": "One sentence summary under 120 characters"}
The title should capture the main topic. The description should give brief context about what was discussed or decided.`;

/**
 * Generate a short title and description for a conversation based on the user prompt and synthesis.
 * Uses a fast model to keep cost/latency low.
 * Falls back to a truncated prompt on failure.
 */
export async function generateTitle({ userPrompt, synthesisContent, apiKey, signal }) {
  const truncatedPrompt = userPrompt.slice(0, 500);
  const truncatedSynthesis = synthesisContent ? synthesisContent.slice(0, 1000) : '';

  const userMessage = truncatedSynthesis
    ? `User asked: "${truncatedPrompt}"\n\nSynthesized answer: "${truncatedSynthesis}"`
    : `User asked: "${truncatedPrompt}"`;

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

    const parsed = parseResponse(content);
    if (parsed) return parsed;
    return fallback(userPrompt);
  } catch {
    return fallback(userPrompt);
  }
}

function parseResponse(text) {
  try {
    const parsed = JSON.parse(text.trim());
    const title = (parsed.title || '').trim().replace(/^["']|["']$/g, '');
    const description = (parsed.description || '').trim().replace(/^["']|["']$/g, '');
    if (title && title.length > 0 && title.length < 100) {
      return { title, description: description.slice(0, 200) };
    }
    return null;
  } catch {
    // Try to extract JSON from surrounding text
    const match = text.match(/\{[\s\S]*?"title"[\s\S]*?\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        const title = (parsed.title || '').trim().replace(/^["']|["']$/g, '');
        const description = (parsed.description || '').trim().replace(/^["']|["']$/g, '');
        if (title && title.length > 0 && title.length < 100) {
          return { title, description: description.slice(0, 200) };
        }
      } catch {
        // fall through
      }
    }
    // Legacy fallback: if the model returned plain text (old format), use it as title
    const plain = text.trim().replace(/^["']|["']$/g, '');
    if (plain && plain.length > 0 && plain.length < 100 && !plain.includes('{')) {
      return { title: plain, description: '' };
    }
    return null;
  }
}

function fallback(prompt) {
  const title = prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt;
  return { title, description: '' };
}
