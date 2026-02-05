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

const FOCUSED_REBUTTAL_SYSTEM_PROMPT = `You are participating in a focused multi-model debate. Be concise and direct. Focus only on substantial points of agreement and disagreement — skip preamble, filler, and restating the obvious.

Your job:
1. State where you agree with other models in 1-2 sentences max
2. Challenge only substantive errors or weak reasoning — be specific and brief
3. State your refined position clearly and concisely

Rules:
- No introductions or pleasantries
- No restating the question
- No hedging language ("it's worth noting that...")
- Every sentence must add new information or a concrete challenge
- Aim for half the length of a normal response`;

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
{"converged": true, "confidence": 85, "reason": "Brief explanation", "agreements": ["point 1", "point 2"], "disagreements": [{"point": "the issue", "models": {"model_id_1": "position A", "model_id_2": "position B"}}]}

Field definitions:
- "converged": boolean — true only when models substantially agree on key points
- "confidence": 0-100 — how close to consensus (100 = perfect agreement, 0 = total disagreement)
- "reason": brief explanation of convergence status
- "agreements": list of specific points where models agree
- "disagreements": list of specific points of disagreement, with each model's position

Be conservative: if there are still meaningful disagreements, return converged: false with a lower confidence score.`;

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
export function buildRebuttalMessages({ userPrompt, previousRoundStreams, roundNumber, conversationHistory, focused = false }) {
  const previousResponses = previousRoundStreams
    .filter(s => s.content && s.status === 'complete')
    .map(s => `### ${getModelDisplayName(s.model)} (${s.model})\n${s.content}`)
    .join('\n\n---\n\n');

  const systemPrompt = focused ? FOCUSED_REBUTTAL_SYSTEM_PROMPT : REBUTTAL_SYSTEM_PROMPT;

  const messages = [
    { role: 'system', content: systemPrompt },
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

function sliceBalancedObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
      if (depth < 0) return null;
    }
  }
  return null;
}

function extractJsonObjectContainingKey(text, requiredKey) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const keyToken = `"${requiredKey}"`;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const candidate = sliceBalancedObject(text, i);
    if (!candidate || !candidate.includes(keyToken)) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, requiredKey)) {
        return parsed;
      }
    } catch {
      // keep scanning
    }
  }

  return null;
}

/**
 * Parse the convergence check response. Handles various formats
 * the model might return (raw JSON, markdown-wrapped, etc.).
 */
export function parseConvergenceResponse(text) {
  function extractFields(parsed) {
    return {
      converged: Boolean(parsed.converged),
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : (parsed.converged ? 80 : 30),
      reason: parsed.reason || 'No reason provided',
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
      disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements : [],
    };
  }

  try {
    const parsed = JSON.parse(text.trim());
    return extractFields(parsed);
  } catch {
    const parsed = extractJsonObjectContainingKey(text, 'converged');
    if (parsed) {
      return extractFields(parsed);
    }

    return {
      converged: false,
      confidence: 0,
      reason: 'Could not parse convergence response',
      agreements: [],
      disagreements: [],
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

// ===== ENSEMBLE VOTE MODE =====

/**
 * System prompt for JSON vote analysis. A fast model evaluates agreement
 * across all model responses and produces structured metadata.
 */
const ENSEMBLE_VOTE_ANALYSIS_PROMPT = `You are an expert analyst evaluating multiple AI model responses to the same query.

Analyze the responses and produce a JSON assessment. You must respond with ONLY a JSON object (no markdown, no code fences):

{
  "confidence": <number 0-100>,
  "outliers": [{"model": "<model id>", "reason": "<brief reason>"}],
  "agreementAreas": ["<area of agreement>", ...],
  "disagreementAreas": ["<area of disagreement>", ...],
  "modelWeights": {"<model id>": <0.0-1.0>, ...}
}

Guidelines:
- **confidence**: 0-100 score reflecting overall consensus. 90+ = strong consensus, 70-89 = good agreement, 50-69 = partial agreement, 30-49 = significant disagreement, <30 = major conflict.
- **outliers**: Models whose answers diverge substantially from the majority. Empty array if none.
- **agreementAreas**: Key points where most or all models agree. Be specific.
- **disagreementAreas**: Key points where models disagree. Be specific.
- **modelWeights**: Relative quality/reliability weight for each model (0.0-1.0). Higher = better reasoning, more accurate, more thorough. Weights should sum close to 1.0.

Be precise and objective. Focus on substantive differences, not stylistic ones.`;

/**
 * System prompt for ensemble synthesis informed by vote analysis results.
 */
const ENSEMBLE_SYNTHESIS_PROMPT = `You are a synthesis expert producing a final answer informed by a structured vote analysis of multiple AI model responses.

You have been given:
1. The original user query
2. Individual model responses
3. A vote analysis with confidence score, outlier detection, agreement/disagreement areas, and model quality weights

Your job:
- Weight your synthesis according to the model weights — higher-weighted models should have more influence
- Strongly reflect the agreement areas — these are the most reliable conclusions
- Address disagreement areas explicitly, explaining which position is stronger and why
- If outlier models were identified, evaluate whether they caught something the others missed or made an error
- Produce a comprehensive, authoritative final answer

Do NOT simply summarize. Synthesize the best answer using the vote analysis as your guide.`;

/**
 * Focused system prompt for ensemble Phase 1: concise independent analyses.
 */
const FOCUSED_ENSEMBLE_ANALYSIS_PROMPT = `You are an expert analyst providing a concise, focused response. Be direct and substantive — skip preamble, filler, and hedging.

Rules:
- No introductions or pleasantries
- No restating the question
- No hedging language ("it's worth noting that...")
- Every sentence must add new information or a concrete insight
- Use bullet points or short paragraphs — aim for half the length of a typical response
- Prioritize accuracy and specificity over comprehensiveness`;

/**
 * Focused system prompt for ensemble Phase 3: concise synthesis.
 */
const FOCUSED_ENSEMBLE_SYNTHESIS_PROMPT = `You are a synthesis expert producing a concise, focused final answer informed by a structured vote analysis of multiple AI model responses.

You have been given:
1. The original user query
2. Individual model responses
3. A vote analysis with confidence score, outlier detection, agreement/disagreement areas, and model quality weights

Your job:
- Synthesize a direct, to-the-point answer weighted by model quality scores
- Lead with the key conclusion, then support it briefly
- Mention disagreements only when they materially affect the answer
- Skip filler, hedging, and unnecessary context
- Aim for half the length of a typical synthesis

Do NOT simply summarize. Produce a sharp, authoritative answer.`;

/**
 * Returns the focused system prompt for ensemble Phase 1 independent analyses.
 */
export function getFocusedEnsembleAnalysisPrompt() {
  return FOCUSED_ENSEMBLE_ANALYSIS_PROMPT;
}

/**
 * Build messages for the ensemble vote analysis (Phase 2).
 */
export function buildEnsembleVoteMessages({ userPrompt, streams }) {
  const responses = streams
    .filter(s => s.content && s.status === 'complete')
    .map(s => `### ${getModelDisplayName(s.model)} (${s.model})\n${s.content}`)
    .join('\n\n---\n\n');

  return [
    { role: 'system', content: ENSEMBLE_VOTE_ANALYSIS_PROMPT },
    {
      role: 'user',
      content: `The user asked: "${userPrompt}"

Here are the model responses:

${responses}

Analyze the agreement and produce your JSON assessment.`,
    },
  ];
}

/**
 * Build messages for ensemble synthesis (Phase 3).
 * Includes individual responses plus the vote analysis metadata.
 */
export function buildEnsembleSynthesisMessages({ userPrompt, streams, voteAnalysis, conversationHistory, focused = false }) {
  const responses = streams
    .filter(s => s.content && s.status === 'complete')
    .map(s => `### ${getModelDisplayName(s.model)} (${s.model})\n${s.content}`)
    .join('\n\n---\n\n');

  const voteContext = `**Vote Analysis Results:**
- Confidence: ${voteAnalysis.confidence}/100
- Agreement Areas: ${voteAnalysis.agreementAreas?.join('; ') || 'None identified'}
- Disagreement Areas: ${voteAnalysis.disagreementAreas?.join('; ') || 'None identified'}
- Outliers: ${voteAnalysis.outliers?.length > 0 ? voteAnalysis.outliers.map(o => `${o.model}: ${o.reason}`).join('; ') : 'None'}
- Model Weights: ${Object.entries(voteAnalysis.modelWeights || {}).map(([m, w]) => `${getModelDisplayName(m)}: ${w}`).join(', ')}`;

  return [
    { role: 'system', content: focused ? FOCUSED_ENSEMBLE_SYNTHESIS_PROMPT : ENSEMBLE_SYNTHESIS_PROMPT },
    ...conversationHistory,
    {
      role: 'user',
      content: `User's query: "${userPrompt}"

${voteContext}

Here are the individual model responses:

${responses}

Now synthesize the best possible answer, weighted by the vote analysis.`,
    },
  ];
}

/**
 * Parse the ensemble vote analysis JSON response.
 * Handles raw JSON, markdown-wrapped JSON, etc.
 */
export function parseEnsembleVoteResponse(text) {
  const defaults = {
    confidence: 50,
    outliers: [],
    agreementAreas: [],
    disagreementAreas: [],
    modelWeights: {},
  };

  try {
    const parsed = JSON.parse(text.trim());
    return {
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : defaults.confidence,
      outliers: Array.isArray(parsed.outliers) ? parsed.outliers : defaults.outliers,
      agreementAreas: Array.isArray(parsed.agreementAreas) ? parsed.agreementAreas : defaults.agreementAreas,
      disagreementAreas: Array.isArray(parsed.disagreementAreas) ? parsed.disagreementAreas : defaults.disagreementAreas,
      modelWeights: parsed.modelWeights && typeof parsed.modelWeights === 'object' ? parsed.modelWeights : defaults.modelWeights,
    };
  } catch {
    const parsed = extractJsonObjectContainingKey(text, 'confidence');
    if (parsed) {
      return {
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : defaults.confidence,
        outliers: Array.isArray(parsed.outliers) ? parsed.outliers : defaults.outliers,
        agreementAreas: Array.isArray(parsed.agreementAreas) ? parsed.agreementAreas : defaults.agreementAreas,
        disagreementAreas: Array.isArray(parsed.disagreementAreas) ? parsed.disagreementAreas : defaults.disagreementAreas,
        modelWeights: parsed.modelWeights && typeof parsed.modelWeights === 'object' ? parsed.modelWeights : defaults.modelWeights,
      };
    }

    return defaults;
  }
}
