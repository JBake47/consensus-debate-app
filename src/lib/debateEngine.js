import { getModelDisplayName } from './openrouter';

/**
 * System prompt for rebuttal rounds. Each model sees all previous round
 * responses and is encouraged to find errors, challenge reasoning, and
 * refine its own position.
 */
const REBUTTAL_SYSTEM_PROMPT = `You are participating in a multi-model debate. Other AI models have responded to the same user query. Your job is to:

1. Carefully review each other model's response
2. Identify factual errors, logical fallacies, or weak reasoning in their answers
3. Acknowledge strong points and areas where you agree
4. Refine and improve your own position based on the discussion

Structure your response with these sections:
## Areas of Agreement
Briefly note where the models align.

## Challenges to Other Models
Point out specific errors, unsupported claims, or logical gaps in other responses. Be direct and specific.

## Revised Position
Present your updated, refined answer to the user's original question, incorporating insights from the discussion.`;

/**
 * System prompt for convergence checking. A fast model evaluates whether
 * the debaters have reached consensus.
 */
const CONVERGENCE_SYSTEM_PROMPT = `You are a debate judge evaluating whether multiple AI models have converged on a consensus answer.

Analyze the latest round of responses and determine:
- Are the models in substantial agreement on the core answer?
- Have they resolved their major disagreements?
- Are remaining differences only minor/stylistic rather than substantive?

You must respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"converged": true, "reason": "Brief explanation of why they converged or not"}

Be conservative: if there are still meaningful disagreements on facts, approach, or conclusions, return converged: false. Only return converged: true when the models substantially agree on the key points.`;

/**
 * System prompt for final synthesis that accounts for multi-round debate history.
 */
const MULTI_ROUND_SYNTHESIS_PROMPT = `You are a synthesis expert. You have access to a full multi-round debate between AI models on the user's query.

The models debated across multiple rounds, challenging each other's reasoning and refining their positions. Your job is to:

1. Trace how positions evolved across the debate rounds
2. Identify the strongest final positions from each model
3. Resolve any remaining conflicts using the best evidence and reasoning from the debate
4. Synthesize a comprehensive, authoritative final answer

Do NOT simply summarize what each model said. Create a unified answer that represents the best thinking that emerged from the debate process. If the models converged on an answer, present it clearly. If they diverged, explain why and present the most well-supported conclusion.`;

/**
 * Build the messages array for a rebuttal round.
 * Each model sees the user prompt plus all responses from the previous round.
 */
export function buildRebuttalMessages({ userPrompt, previousRoundStreams, roundNumber, conversationHistory }) {
  const previousResponses = previousRoundStreams
    .filter(s => s.content && s.status === 'complete')
    .map(s => `### ${getModelDisplayName(s.model)} (${s.model})\n${s.content}`)
    .join('\n\n---\n\n');

  const messages = [
    { role: 'system', content: REBUTTAL_SYSTEM_PROMPT },
    ...conversationHistory,
    {
      role: 'user',
      content: `Original question: "${userPrompt}"

Here are the responses from Round ${roundNumber - 1} of the debate:

${previousResponses}

Now provide your rebuttal and revised position for Round ${roundNumber}.`,
    },
  ];

  return messages;
}

/**
 * Build the messages array for a convergence check.
 */
export function buildConvergenceMessages({ userPrompt, latestRoundStreams, roundNumber }) {
  const responses = latestRoundStreams
    .filter(s => s.content && s.status === 'complete')
    .map(s => `### ${getModelDisplayName(s.model)} (${s.model})\n${s.content}`)
    .join('\n\n---\n\n');

  return [
    { role: 'system', content: CONVERGENCE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `The user asked: "${userPrompt}"

Here are the model responses from Round ${roundNumber} of the debate:

${responses}

Have the models converged on a consensus answer? Respond with JSON only.`,
    },
  ];
}

/**
 * Build the messages array for multi-round synthesis.
 * Includes the full debate history across all rounds.
 */
export function buildMultiRoundSynthesisMessages({ userPrompt, rounds, conversationHistory }) {
  const debateHistory = rounds
    .map(round => {
      const responses = round.streams
        .filter(s => s.content)
        .map(s => `#### ${getModelDisplayName(s.model)}\n${s.content}`)
        .join('\n\n');

      let section = `### ${round.label}\n${responses}`;

      if (round.convergenceCheck) {
        section += `\n\n**Convergence check:** ${round.convergenceCheck.converged ? 'Converged' : 'Not converged'} — ${round.convergenceCheck.reason}`;
      }

      return section;
    })
    .join('\n\n---\n\n');

  return [
    { role: 'system', content: MULTI_ROUND_SYNTHESIS_PROMPT },
    ...conversationHistory,
    {
      role: 'user',
      content: `User's query: "${userPrompt}"

Here is the full debate history:

${debateHistory}

Now synthesize the best possible answer from this debate.`,
    },
  ];
}

/**
 * Parse the convergence check response. Handles various formats
 * the model might return (raw JSON, markdown-wrapped, etc.).
 */
export function parseConvergenceResponse(text) {
  try {
    // Try direct JSON parse first
    const parsed = JSON.parse(text.trim());
    return {
      converged: Boolean(parsed.converged),
      reason: parsed.reason || 'No reason provided',
    };
  } catch {
    // Try to extract JSON from markdown code fences or surrounding text
    const jsonMatch = text.match(/\{[\s\S]*?"converged"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          converged: Boolean(parsed.converged),
          reason: parsed.reason || 'No reason provided',
        };
      } catch {
        // fall through
      }
    }

    // Default to not converged if we can't parse
    return {
      converged: false,
      reason: 'Could not parse convergence response',
    };
  }
}

/**
 * Create an empty round structure.
 */
export function createRound({ roundNumber, label, models }) {
  return {
    roundNumber,
    label,
    status: 'pending',
    streams: models.map(model => ({
      model,
      content: '',
      status: 'pending',
      error: null,
      usage: null,
      durationMs: null,
    })),
    convergenceCheck: null,
  };
}

/**
 * Get the label for a given round number.
 */
export function getRoundLabel(roundNumber) {
  if (roundNumber === 1) return 'Initial Responses';
  return `Rebuttal Round ${roundNumber - 1}`;
}
