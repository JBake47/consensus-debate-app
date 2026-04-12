import { getAttachmentTypeLabel } from './attachmentPreview.js';
import { buildTurnContextSummary } from './conversationIndex.js';
import { getModelDisplayName } from './openrouter.js';

export const TRANSFER_PACKET_VARIANT_COMPACT = 'compact';
export const TRANSFER_PACKET_VARIANT_EXTENDED = 'extended';
export const TRANSFER_PACKET_PROFILE_GENERAL = 'general';
export const TRANSFER_PACKET_PROFILE_CODING = 'coding';
export const TRANSFER_PACKET_PROFILE_RESEARCH = 'research';

const MAX_RECENT_TURNS = 3;
const MAX_RECENT_ATTACHMENTS = 6;
const MAX_FACTS = 6;
const MAX_DECISIONS = 5;
const MAX_OPEN_QUESTIONS = 5;
const MAX_CONSTRAINTS = 6;
const MAX_ATTACHMENTS = 4;
const MAX_PROVENANCE = 5;
const MAX_AGREEMENTS = 4;
const MAX_DISAGREEMENTS = 5;
const MAX_RECENT_TURN_ITEMS = 3;
const SUMMARY_FALLBACK_TURN_LIMIT = 3;

const VARIANT_CHAR_TARGETS = {
  [TRANSFER_PACKET_VARIANT_COMPACT]: 9000,
  [TRANSFER_PACKET_VARIANT_EXTENDED]: 14000,
};

const PROFILE_SECTION_PRIORITIES = {
  [TRANSFER_PACKET_PROFILE_GENERAL]: {
    conversationState: 109,
    mostRecentAnswer: 108,
    settledFacts: 107,
    decisionsMade: 106,
    openQuestions: 105,
    constraints: 104,
    nextAction: 103,
    runSettings: 82,
    sourceProvenance: 78,
    attachmentContext: 76,
    agreements: 74,
    disagreements: 80,
    recentTurnSummaries: 68,
    machineReadable: 70,
  },
  [TRANSFER_PACKET_PROFILE_CODING]: {
    conversationState: 109,
    mostRecentAnswer: 108,
    settledFacts: 107,
    decisionsMade: 106,
    openQuestions: 105,
    constraints: 104,
    nextAction: 103,
    runSettings: 94,
    sourceProvenance: 72,
    attachmentContext: 91,
    agreements: 70,
    disagreements: 86,
    recentTurnSummaries: 74,
    machineReadable: 68,
  },
  [TRANSFER_PACKET_PROFILE_RESEARCH]: {
    conversationState: 109,
    mostRecentAnswer: 108,
    settledFacts: 107,
    decisionsMade: 106,
    openQuestions: 105,
    constraints: 104,
    nextAction: 103,
    runSettings: 78,
    sourceProvenance: 97,
    attachmentContext: 72,
    agreements: 88,
    disagreements: 92,
    recentTurnSummaries: 74,
    machineReadable: 68,
  },
};

function normalizeVariant(variant) {
  return variant === TRANSFER_PACKET_VARIANT_EXTENDED
    ? TRANSFER_PACKET_VARIANT_EXTENDED
    : TRANSFER_PACKET_VARIANT_COMPACT;
}

function normalizeProfile(profile) {
  if (profile === TRANSFER_PACKET_PROFILE_CODING) return TRANSFER_PACKET_PROFILE_CODING;
  if (profile === TRANSFER_PACKET_PROFILE_RESEARCH) return TRANSFER_PACKET_PROFILE_RESEARCH;
  return TRANSFER_PACKET_PROFILE_GENERAL;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeInlineText(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxChars) {
  const safeText = normalizeText(value);
  if (!safeText) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || safeText.length <= maxChars) {
    return safeText;
  }
  return `${safeText.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function toIsoTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function sanitizeFileName(value) {
  return String(value || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function downloadTextFile(content, filename, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function dedupeStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const normalized = normalizeInlineText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizePinLines(value) {
  if (Array.isArray(value)) {
    return dedupeStrings(value);
  }

  const text = normalizeText(value);
  if (!text) return [];

  return dedupeStrings(
    text
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, ''))
  );
}

function splitIntoItems(text, maxCharsPerItem = 260) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const parts = normalized
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((part) => truncateText(part, maxCharsPerItem))
    .filter(Boolean);

  return dedupeStrings(parts);
}

function takeItems(items, maxItems) {
  if (!Array.isArray(items) || maxItems <= 0) return [];
  return items.slice(0, maxItems);
}

function formatProfileLabel(profile) {
  if (profile === TRANSFER_PACKET_PROFILE_CODING) return 'Coding';
  if (profile === TRANSFER_PACKET_PROFILE_RESEARCH) return 'Research';
  return 'General';
}

function formatModelReference(modelId) {
  const rawId = normalizeInlineText(modelId);
  if (rawId) return rawId;
  return normalizeInlineText(getModelDisplayName(modelId) || '');
}

function formatModeLabel(mode) {
  if (mode === 'parallel') return 'Parallel';
  if (mode === 'direct') return 'Direct';
  return 'Debate';
}

function getTurnSummary(turn, maxChars = Infinity) {
  const existingSummary = normalizeText(turn?.contextSummary);
  const summary = existingSummary || normalizeText(buildTurnContextSummary(turn));
  return truncateText(summary, maxChars);
}

function getFinalRound(turn) {
  return Array.isArray(turn?.rounds) && turn.rounds.length > 0
    ? turn.rounds[turn.rounds.length - 1]
    : null;
}

function getCompletedStreams(turn) {
  const finalRound = getFinalRound(turn);
  return (finalRound?.streams || []).filter((stream) => (
    stream?.status === 'complete' && normalizeText(stream?.content)
  ));
}

function truncateSections(sections, maxChars) {
  const safeSections = sections
    .map((section) => normalizeText(section))
    .filter(Boolean);

  if (safeSections.length === 0) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return safeSections.join('\n\n');
  }

  const output = [];
  let remaining = maxChars;

  for (const section of safeSections) {
    const separatorLength = output.length > 0 ? 2 : 0;
    if (section.length + separatorLength <= remaining) {
      output.push(section);
      remaining -= section.length + separatorLength;
      continue;
    }

    const allowedChars = Math.max(0, remaining - separatorLength);
    if (allowedChars > 0) {
      output.push(truncateText(section, allowedChars));
    }
    break;
  }

  return output.join('\n\n');
}

function getTurnMostRecentAnswer(turn, maxChars) {
  const synthesis = turn?.synthesis?.status === 'complete'
    ? normalizeText(turn?.synthesis?.content)
    : '';
  if (synthesis) {
    return truncateText(synthesis, maxChars);
  }

  if (turn?.mode !== 'parallel') {
    return '';
  }

  const completedStreamAnswers = getCompletedStreams(turn)
    .map((stream, index) => {
      const modelName = formatModelReference(stream?.model) || `Model ${index + 1}`;
      return `${modelName}:\n${normalizeText(stream.content)}`;
    });

  return truncateSections(completedStreamAnswers, maxChars);
}

function getTurnLatestState(turn, maxChars) {
  const summary = getTurnSummary(turn, maxChars);
  if (summary) {
    return summary;
  }

  const searchContent = normalizeText(turn?.webSearchResult?.content);
  return truncateText(searchContent, maxChars);
}

function normalizeTransferPins(rawPins) {
  const pins = rawPins && typeof rawPins === 'object' ? rawPins : {};
  return {
    settledFacts: normalizePinLines(pins.settledFacts ?? pins.facts),
    constraints: normalizePinLines(pins.constraints),
  };
}

function parseLinesToPins(text) {
  return normalizePinLines(text);
}

function getPacketFilename(conversation, options = {}) {
  const variant = normalizeVariant(options.variant);
  const profile = normalizeProfile(options.profile);
  const dateStamp = new Date(options.generatedAt || Date.now()).toISOString().slice(0, 10);
  const profileSuffix = profile === TRANSFER_PACKET_PROFILE_GENERAL ? '' : `-${profile}`;
  return `${sanitizeFileName(conversation?.title || 'conversation') || 'conversation'}-${dateStamp}-transfer-${variant}${profileSuffix}.md`;
}

function getConversationState(latestTurn, latestAnswer) {
  if (latestTurn?.userPrompt && latestAnswer) {
    return 'answered';
  }
  if (latestTurn?.userPrompt) {
    return 'active';
  }
  return 'idle';
}

function summarizeAttachment(attachment, route) {
  const name = normalizeInlineText(attachment?.name || 'Unnamed attachment');
  const typeLabel = getAttachmentTypeLabel(attachment);
  const routeLabel = normalizeInlineText(route?.primaryLabel);
  const preview = truncateText(
    normalizeInlineText(attachment?.content || attachment?.inlineWarning || attachment?.summary || ''),
    160,
  );

  const parts = [`${name}: ${typeLabel}`];
  if (routeLabel) {
    parts.push(`routing ${routeLabel.toLowerCase()}`);
  }
  if (preview) {
    parts.push(`contains ${preview}`);
  } else {
    parts.push('supporting material for the conversation');
  }

  return parts.join('; ');
}

function collectAttachmentContext(turns) {
  const items = [];
  const seen = new Set();

  for (const turn of turns) {
    const attachments = Array.isArray(turn?.attachments) ? turn.attachments : [];
    const routing = Array.isArray(turn?.attachmentRouting) ? turn.attachmentRouting : [];
    attachments.forEach((attachment, index) => {
      const name = normalizeInlineText(attachment?.name);
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      items.push(summarizeAttachment(attachment, routing[index]));
    });
  }

  return takeItems(items, MAX_RECENT_ATTACHMENTS);
}

function formatSearchProvenanceItem(item) {
  const label = item.title || item.domain || item.url;
  const published = item.publishedAt ? ` (${item.publishedAt})` : '';
  const summary = item.summary || 'Referenced supporting source.';
  return `[${label}](${item.url})${published} - ${summary}`;
}

function normalizeUrlCandidate(rawUrl) {
  const cleaned = String(rawUrl || '').trim().replace(/[),.;]+$/, '');
  if (!cleaned) return null;
  try {
    return new URL(cleaned).toString();
  } catch {
    return null;
  }
}

function getDomainFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function extractUrlsFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s)]+/g) || [];
  return Array.from(new Set(matches.map(normalizeUrlCandidate).filter(Boolean)));
}

function extractDateFromText(text) {
  const isoMatch = String(text || '').match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch?.[0]) return isoMatch[0];
  const naturalMatch = String(text || '').match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b/i);
  return naturalMatch?.[0] || null;
}

function collectSourceProvenance(turns) {
  const provenance = [];
  const seen = new Set();

  for (const turn of turns) {
    for (const stream of getCompletedStreams(turn)) {
      const searchEvidence = stream?.searchEvidence;
      const structured = Array.isArray(searchEvidence?.structuredCitations)
        ? searchEvidence.structuredCitations
        : [];

      for (const citation of structured) {
        const url = normalizeUrlCandidate(citation?.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        provenance.push({
          url,
          domain: citation?.domain || getDomainFromUrl(url),
          title: normalizeInlineText(citation?.title),
          publishedAt: citation?.publishedAt || null,
          summary: truncateText(
            normalizeInlineText(citation?.snippet || citation?.title || ''),
            180,
          ) || 'Referenced supporting source.',
        });
        if (provenance.length >= MAX_PROVENANCE) {
          return provenance;
        }
      }

      if (structured.length === 0) {
        for (const url of searchEvidence?.urls || []) {
          const normalizedUrl = normalizeUrlCandidate(url);
          if (!normalizedUrl || seen.has(normalizedUrl)) continue;
          seen.add(normalizedUrl);
          provenance.push({
            url: normalizedUrl,
            domain: getDomainFromUrl(normalizedUrl),
            title: '',
            publishedAt: null,
            summary: 'Referenced in model-provided web evidence.',
          });
          if (provenance.length >= MAX_PROVENANCE) {
            return provenance;
          }
        }
      }
    }

    const legacySearchContent = normalizeText(turn?.webSearchResult?.content);
    if (legacySearchContent) {
      for (const url of extractUrlsFromText(legacySearchContent)) {
        if (seen.has(url)) continue;
        seen.add(url);
        provenance.push({
          url,
          domain: getDomainFromUrl(url),
          title: '',
          publishedAt: extractDateFromText(legacySearchContent),
          summary: 'Referenced in legacy web-search context.',
        });
        if (provenance.length >= MAX_PROVENANCE) {
          return provenance;
        }
      }
    }
  }

  return provenance;
}

function formatAgreementItem(item) {
  if (typeof item === 'string') {
    return normalizeInlineText(item);
  }
  if (!item || typeof item !== 'object') return '';
  if (typeof item.point === 'string') return normalizeInlineText(item.point);
  return normalizeInlineText(item.reason || item.summary || '');
}

function formatDisagreementItem(item) {
  if (typeof item === 'string') {
    return normalizeInlineText(item);
  }
  if (!item || typeof item !== 'object') return '';

  const point = normalizeInlineText(item.point || item.reason || item.summary || '');
  const modelPositions = item.models && typeof item.models === 'object'
    ? Object.entries(item.models)
      .map(([modelId, value]) => {
        const modelName = formatModelReference(modelId) || modelId;
        return value ? `${modelName}: ${normalizeInlineText(value)}` : modelName;
      })
      .filter(Boolean)
      .join(' | ')
    : '';

  return point && modelPositions
    ? `${point} (${modelPositions})`
    : (point || modelPositions);
}

function collectAgreements(turn) {
  const items = [];
  if (Array.isArray(turn?.ensembleResult?.agreementAreas)) {
    items.push(...turn.ensembleResult.agreementAreas.map(formatAgreementItem));
  }
  for (const round of turn?.rounds || []) {
    if (Array.isArray(round?.convergenceCheck?.agreements)) {
      items.push(...round.convergenceCheck.agreements.map(formatAgreementItem));
    }
  }
  return takeItems(dedupeStrings(items), MAX_AGREEMENTS);
}

function collectDisagreements(turn) {
  const items = [];
  if (Array.isArray(turn?.ensembleResult?.disagreementAreas)) {
    items.push(...turn.ensembleResult.disagreementAreas.map(formatDisagreementItem));
  }
  if (Array.isArray(turn?.ensembleResult?.outliers)) {
    items.push(...turn.ensembleResult.outliers.map((outlier) => (
      outlier?.model && outlier?.reason
        ? `${formatModelReference(outlier.model) || outlier.model}: ${normalizeInlineText(outlier.reason)}`
        : formatDisagreementItem(outlier)
    )));
  }
  for (const round of turn?.rounds || []) {
    if (Array.isArray(round?.convergenceCheck?.disagreements)) {
      items.push(...round.convergenceCheck.disagreements.map(formatDisagreementItem));
    }
    const reason = normalizeInlineText(round?.convergenceCheck?.reason);
    if (reason && round?.convergenceCheck?.converged === false) {
      items.push(reason);
    }
  }
  return takeItems(dedupeStrings(items), MAX_DISAGREEMENTS);
}

function collectTurnModels(turn) {
  const models = [];
  if (Array.isArray(turn?.modelOverrides)) {
    models.push(...turn.modelOverrides);
  }
  for (const round of turn?.rounds || []) {
    for (const stream of round?.streams || []) {
      if (stream?.model) {
        models.push(stream.model);
      }
    }
  }
  return dedupeStrings(models.map((model) => formatModelReference(model) || String(model || '').trim()));
}

function buildStructuredRunSettings(turn) {
  if (!turn || typeof turn !== 'object') return null;

  const modelRoster = collectTurnModels(turn);
  const roundsRun = Number.isFinite(Number(turn?.debateMetadata?.totalRounds))
    ? Math.max(0, Math.floor(Number(turn.debateMetadata.totalRounds)))
    : (Array.isArray(turn?.rounds) ? turn.rounds.length : 0);
  const converged = turn?.mode === 'debate' && roundsRun > 0
    ? turn?.debateMetadata?.converged === true
    : null;
  const outcome = normalizeInlineText(turn?.debateMetadata?.terminationReason);

  return {
    mode: normalizeInlineText(turn?.mode) || null,
    focusedMode: Boolean(turn?.focusedMode),
    webSearchEnabled: Boolean(turn?.webSearchEnabled),
    modelRoster,
    synthesisModel: formatModelReference(turn?.synthesis?.model) || null,
    searchModel: formatModelReference(turn?.webSearchResult?.model) || null,
    roundsRun: roundsRun > 0 ? roundsRun : null,
    converged,
    outcome: outcome || null,
  };
}

function buildRunSettings(turn) {
  const run = buildStructuredRunSettings(turn);
  if (!run) return [];
  const settings = [];
  settings.push(`Mode: ${formatModeLabel(run.mode)}.`);
  settings.push(`Focused replies: ${run.focusedMode ? 'on' : 'off'}.`);
  settings.push(`Web search: ${run.webSearchEnabled ? 'on' : 'off'}.`);
  if (run.modelRoster.length > 0) {
    settings.push(`Model roster: ${run.modelRoster.join(', ')}.`);
  }
  if (run.synthesisModel) {
    settings.push(`Synthesis model: ${run.synthesisModel}.`);
  }
  if (run.searchModel) {
    settings.push(`Search model: ${run.searchModel}.`);
  }
  if (run.roundsRun) {
    settings.push(`Rounds run: ${run.roundsRun}.`);
  }
  if (run.mode === 'debate' && run.roundsRun) {
    settings.push(`Debate converged: ${run.converged ? 'yes' : 'no'}${run.outcome ? ` (${run.outcome})` : ''}.`);
  } else if (run.outcome) {
    settings.push(`Run outcome: ${run.outcome}.`);
  }

  return dedupeStrings(settings);
}

function buildSummarySource(conversation, recentTurnCount) {
  const runningSummary = normalizeText(conversation?.runningSummary);
  if (runningSummary) {
    return splitIntoItems(runningSummary, 240);
  }

  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const olderTurns = turns.slice(0, Math.max(0, turns.length - recentTurnCount));
  const summaries = olderTurns
    .slice(-SUMMARY_FALLBACK_TURN_LIMIT)
    .map((turn) => getTurnSummary(turn, 320))
    .filter(Boolean);

  return dedupeStrings(summaries.flatMap((summary) => splitIntoItems(summary, 240)));
}

function classifySummaryItems(items) {
  const facts = [];
  const decisions = [];
  const openQuestions = [];

  const decisionRegex = /\b(decid|prefer|plan|implement|use|switch|keep|replace|add|ship|export|copy|download)\b/i;
  const openRegex = /\b(open|unknown|unclear|pending|follow-up|needs|todo|question)\b/i;

  for (const item of items) {
    if (openRegex.test(item) && openQuestions.length < MAX_OPEN_QUESTIONS) {
      openQuestions.push(item);
      continue;
    }
    if (decisionRegex.test(item) && decisions.length < MAX_DECISIONS) {
      decisions.push(item);
      continue;
    }
    if (facts.length < MAX_FACTS) {
      facts.push(item);
    }
  }

  return {
    facts: dedupeStrings(facts),
    decisions: dedupeStrings(decisions),
    openQuestions: dedupeStrings(openQuestions),
  };
}

function buildObjective(conversation, latestTurn, profile) {
  const description = normalizeText(conversation?.description);
  if (description) {
    return description;
  }

  const runningSummary = normalizeText(conversation?.runningSummary);
  if (runningSummary) {
    const firstItem = splitIntoItems(runningSummary, 220)[0];
    if (firstItem) return firstItem;
  }

  const latestPrompt = normalizeText(latestTurn?.userPrompt);
  if (latestPrompt) {
    if (profile === TRANSFER_PACKET_PROFILE_CODING) {
      return `Continue the implementation task: ${truncateText(latestPrompt, 220)}`;
    }
    if (profile === TRANSFER_PACKET_PROFILE_RESEARCH) {
      return `Continue the evidence-backed analysis task: ${truncateText(latestPrompt, 220)}`;
    }
    return truncateText(latestPrompt, 220);
  }

  return normalizeInlineText(conversation?.title || 'Continue the conversation in another chat or LLM.');
}

function buildConstraints(conversation, recentTurns, pins, profile) {
  const latestTurn = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1] : null;
  const constraints = [...pins.constraints];

  if (latestTurn?.focusedMode === true) {
    constraints.push('Prefer shorter, tighter replies unless the user explicitly asks for depth.');
  }

  if (recentTurns.some((turn) => Boolean(turn?.webSearchEnabled) || turn?.webSearchResult?.status === 'complete')) {
    constraints.push('Preserve source-backed evidence for date-sensitive or current claims.');
  }

  if (latestTurn?.mode === 'parallel') {
    constraints.push('Keep model disagreements explicit instead of flattening them into false consensus.');
  }

  if (profile === TRANSFER_PACKET_PROFILE_CODING) {
    constraints.push('Stay concrete about files, artifacts, and the next implementation step.');
  } else if (profile === TRANSFER_PACKET_PROFILE_RESEARCH) {
    constraints.push('Carry forward citations, timestamps, and verification gaps for factual claims.');
  }

  const description = normalizeText(conversation?.description);
  if (description) {
    constraints.push(`Conversation description: ${truncateText(description, 220)}`);
  }

  return takeItems(dedupeStrings(constraints), MAX_CONSTRAINTS);
}

function buildConversationStateSection(state, latestTurn) {
  if (state === 'answered') {
    return {
      title: 'Latest Question Answered',
      body: truncateText(latestTurn?.userPrompt || '', 500),
    };
  }

  if (state === 'active') {
    return {
      title: 'Active Request',
      body: truncateText(latestTurn?.userPrompt || '', 700),
    };
  }

  return {
    title: 'Conversation State',
    body: 'No recent turn was available. Continue from the settled context below.',
  };
}

function buildOpenQuestions(state, latestTurn, disagreements, classifiedOpenQuestions) {
  const questions = [...classifiedOpenQuestions];

  if (state === 'active' && latestTurn?.userPrompt) {
    questions.unshift(`Current unresolved request: ${truncateText(latestTurn.userPrompt, 260)}`);
  } else if (state === 'answered') {
    if (disagreements.length > 0) {
      questions.push(`Resolve the remaining disagreement: ${truncateText(disagreements[0], 220)}`);
    } else {
      questions.push('No explicit unresolved question is captured after the latest answered turn.');
    }
  }

  return takeItems(dedupeStrings(questions), MAX_OPEN_QUESTIONS);
}

function buildDecisions(latestTurn, classifiedDecisions, profile) {
  const decisions = [...classifiedDecisions];

  if (latestTurn?.mode === 'debate') {
    decisions.push('Use the multi-round debate result as the basis for continuation, not a fresh restart.');
  } else if (latestTurn?.mode === 'parallel') {
    decisions.push('Keep the side-by-side comparison framing instead of collapsing model outputs too early.');
  } else if (latestTurn?.mode === 'direct') {
    decisions.push('Continue from the ensemble-style merged answer rather than recreating the comparison step.');
  }

  if (profile === TRANSFER_PACKET_PROFILE_CODING) {
    decisions.push('Bias the handoff toward implementation detail and the next concrete change.');
  } else if (profile === TRANSFER_PACKET_PROFILE_RESEARCH) {
    decisions.push('Bias the handoff toward evidence, provenance, and unresolved verification gaps.');
  }

  return takeItems(dedupeStrings(decisions), MAX_DECISIONS);
}

function buildSettledFacts(pins, classifiedFacts, latestAnswer, sourceProvenance) {
  const facts = [...pins.settledFacts, ...classifiedFacts];

  if (latestAnswer) {
    const answerSummary = splitIntoItems(latestAnswer, 220)[0];
    if (answerSummary) {
      facts.push(`Most recent answer outcome: ${answerSummary}`);
    }
  }

  if (sourceProvenance.length > 0) {
    const firstSource = sourceProvenance[0];
    facts.push(`Search provenance is available from ${firstSource.domain || firstSource.url}.`);
  }

  return takeItems(dedupeStrings(facts), MAX_FACTS);
}

function buildNextAction(state, profile, latestTurn, disagreements, provenance) {
  if (state === 'active' && latestTurn?.userPrompt) {
    return truncateText(latestTurn.userPrompt, 320);
  }

  if (disagreements.length > 0) {
    return `Continue from the latest answer, but resolve this disagreement first: ${truncateText(disagreements[0], 220)}`;
  }

  if (profile === TRANSFER_PACKET_PROFILE_CODING) {
    return 'Continue from the latest answer and move directly to the next concrete code change, test, or file-level action.';
  }

  if (profile === TRANSFER_PACKET_PROFILE_RESEARCH && provenance.length > 0) {
    return 'Continue from the latest answer and preserve the cited sources when extending any factual claims.';
  }

  return 'Continue from the latest answer without restarting the conversation. Ask one focused follow-up only if a required fact, source, or attachment is missing.';
}

function buildRecentTurnSummaries(turns) {
  return turns
    .slice(-Math.min(MAX_RECENT_TURNS, turns.length))
    .map((turn, index, recentTurns) => {
      const turnNumber = turns.length - recentTurns.length + index + 1;
      const lines = [`### Turn ${turnNumber}`, ''];
      const prompt = truncateText(turn?.userPrompt, 500);
      const summary = getTurnSummary(turn, 900);

      if (prompt) {
        lines.push('User request:');
        lines.push(prompt);
        lines.push('');
      }
      if (summary) {
        lines.push('Summary:');
        lines.push(summary);
        lines.push('');
      }

      return lines.join('\n').trimEnd();
    })
    .filter(Boolean)
    .slice(0, MAX_RECENT_TURN_ITEMS);
}

function renderBulletSection(section, remainingChars) {
  const items = takeItems(dedupeStrings(section.items || []), section.maxItems || Infinity);
  if (items.length === 0) {
    return { text: '', omitted: 0, truncated: false, skipReason: 'empty' };
  }

  const header = `## ${section.title}\n\n`;
  if (!section.essential && header.length + 8 > remainingChars) {
    return { text: '', omitted: items.length, truncated: false, skipReason: 'size' };
  }

  let kept = [...items];
  let omitted = 0;
  let text = `${header}${kept.map((item) => `- ${item}`).join('\n')}\n`;

  while (kept.length > (section.minimumItems || 1) && text.length > remainingChars) {
    kept.pop();
    omitted += 1;
    text = `${header}${kept.map((item) => `- ${item}`).join('\n')}\n`;
  }

  if (text.length > remainingChars && kept.length > 0) {
    const renderedPrefix = `${header}${kept.slice(0, -1).map((item) => `- ${item}`).join('\n')}${kept.length > 1 ? '\n' : ''}`;
    const remainingForLast = Math.max(40, remainingChars - renderedPrefix.length - 4);
    kept[kept.length - 1] = truncateText(kept[kept.length - 1], remainingForLast);
    text = `${header}${kept.map((item) => `- ${item}`).join('\n')}\n`;
  }

  if (text.length > remainingChars && !section.essential) {
    return { text: '', omitted: items.length, truncated: false, skipReason: 'size' };
  }

  return {
    text: text.trimEnd(),
    omitted,
    truncated: omitted > 0 || text.length > remainingChars,
    skipReason: null,
  };
}

function renderTextSection(section, remainingChars) {
  const body = normalizeText(section.body);
  if (!body) {
    return { text: '', omitted: 0, truncated: false, skipReason: 'empty' };
  }

  const header = `## ${section.title}\n\n`;
  const fullText = `${header}${body}`;
  if (fullText.length <= remainingChars || remainingChars <= 0) {
    return { text: fullText, omitted: 0, truncated: false, skipReason: null };
  }

  if (!section.essential) {
    return { text: '', omitted: 1, truncated: false, skipReason: 'size' };
  }

  const availableBodyChars = Math.max(40, remainingChars - header.length);
  return {
    text: `${header}${truncateText(body, availableBodyChars)}`,
    omitted: 0,
    truncated: true,
    skipReason: null,
  };
}

function renderRawSection(section, remainingChars) {
  const body = normalizeText(section.body);
  if (!body) {
    return { text: '', omitted: 0, truncated: false, skipReason: 'empty' };
  }
  const header = `## ${section.title}\n\n`;
  const fullText = `${header}${body}`;
  if (section.essential) {
    return {
      text: fullText,
      omitted: 0,
      truncated: fullText.length > remainingChars,
      skipReason: null,
    };
  }
  if (fullText.length <= remainingChars) {
    return {
      text: fullText,
      omitted: 0,
      truncated: false,
      skipReason: null,
    };
  }
  return { text: '', omitted: 1, truncated: false, skipReason: 'size' };
}

function packSections(sections, targetChars) {
  const includedSections = [];
  const omittedSections = [];
  const warnings = [];
  let usedChars = 0;

  for (const section of sections) {
    const remaining = Math.max(120, targetChars - usedChars);
    const rendered = section.kind === 'bullet'
      ? renderBulletSection(section, remaining)
      : section.kind === 'raw'
        ? renderRawSection(section, remaining)
        : renderTextSection(section, remaining);

    if (!rendered.text) {
      if (rendered.skipReason === 'size') {
        omittedSections.push(section.title);
      }
      continue;
    }

    includedSections.push(rendered.text);
    usedChars += rendered.text.length + 2;

    if (rendered.omitted > 0) {
      warnings.push(`${section.title} omitted ${rendered.omitted} lower-priority item${rendered.omitted === 1 ? '' : 's'} to stay within the size target.`);
    } else if (rendered.truncated) {
      warnings.push(`${section.title} was truncated to stay within the size target.`);
    }
  }

  return {
    text: includedSections.join('\n\n').trim(),
    omittedSections,
    warnings,
  };
}

function buildMachineReadablePacket({
  conversation,
  variant,
  profile,
  generatedAt,
  objective,
  conversationState,
  mostRecentAnswer,
  latestTurnState,
  settledFacts,
  decisionsMade,
  openQuestions,
  constraints,
  nextAction,
  runSettings,
  agreements,
  disagreements,
  attachmentContext,
  sourceProvenance,
  recentTurnSummaries,
  pins,
  run,
}) {
  return {
    version: 2,
    variant,
    profile,
    generatedAt,
    conversation: {
      id: conversation?.id || null,
      title: normalizeInlineText(conversation?.title || 'Untitled chat'),
      description: normalizeText(conversation?.description || ''),
      turnCount: Array.isArray(conversation?.turns) ? conversation.turns.length : 0,
      state: conversationState.state,
      latestPrompt: conversationState.prompt || '',
      objective,
      nextAction,
    },
    run,
    sections: {
      settledFacts,
      decisionsMade,
      openQuestions,
      constraints,
      runSettings,
      agreements,
      disagreements,
      attachmentContext,
      sourceProvenance: sourceProvenance.map((item) => ({
        url: item.url,
        domain: item.domain,
        title: item.title,
        publishedAt: item.publishedAt,
        summary: item.summary,
      })),
      mostRecentAnswer,
      latestTurnState,
      recentTurnSummaries,
    },
    pins,
  };
}

export function buildConversationTransferPacketBundle(conversation, options = {}) {
  if (!conversation || typeof conversation !== 'object') {
    const variant = normalizeVariant(options.variant);
    const profile = normalizeProfile(options.profile);
    return {
      text: '',
      packet: null,
      meta: {
        variant,
        profile,
        targetChars: VARIANT_CHAR_TARGETS[variant],
        totalChars: 0,
        approxTokens: 0,
        omittedSections: [],
        warnings: [],
      },
    };
  }

  const variant = normalizeVariant(options.variant);
  const profile = normalizeProfile(options.profile);
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const recentTurns = turns.slice(-Math.min(MAX_RECENT_TURNS, turns.length));
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const pins = normalizeTransferPins(options.transferPinsOverride || conversation?.transferPins);
  const latestAnswer = latestTurn ? getTurnMostRecentAnswer(latestTurn, 1800) : '';
  const latestTurnState = latestTurn && !latestAnswer
    ? getTurnLatestState(latestTurn, 1200)
    : '';
  const conversationState = {
    state: getConversationState(latestTurn, latestAnswer),
    prompt: truncateText(latestTurn?.userPrompt || '', 700),
  };
  const objective = buildObjective(conversation, latestTurn, profile);
  const summaryCandidates = buildSummarySource(conversation, recentTurns.length);
  const classified = classifySummaryItems(summaryCandidates);
  const sourceProvenance = collectSourceProvenance([...(latestTurn ? [latestTurn] : []), ...recentTurns.slice(0, -1).reverse()]);
  const attachmentContext = takeItems(
    collectAttachmentContext([...(latestTurn ? [latestTurn] : []), ...recentTurns.slice(0, -1).reverse()]),
    MAX_ATTACHMENTS,
  );
  const agreements = latestTurn ? collectAgreements(latestTurn) : [];
  const disagreements = latestTurn ? collectDisagreements(latestTurn) : [];
  const settledFacts = buildSettledFacts(pins, classified.facts, latestAnswer, sourceProvenance);
  const decisionsMade = buildDecisions(latestTurn, classified.decisions, profile);
  const openQuestions = buildOpenQuestions(
    conversationState.state,
    latestTurn,
    disagreements,
    classified.openQuestions,
  );
  const constraints = buildConstraints(conversation, recentTurns, pins, profile);
  const nextAction = buildNextAction(conversationState.state, profile, latestTurn, disagreements, sourceProvenance);
  const run = latestTurn ? buildStructuredRunSettings(latestTurn) : null;
  const runSettings = latestTurn ? buildRunSettings(latestTurn) : [];
  const recentTurnSummaries = variant === TRANSFER_PACKET_VARIANT_EXTENDED
    ? buildRecentTurnSummaries(turns)
    : [];
  const generatedAt = toIsoTimestamp(options.generatedAt || Date.now());
  const variantLabel = variant === TRANSFER_PACKET_VARIANT_EXTENDED ? 'Extended' : 'Compact';
  const profileLabel = formatProfileLabel(profile);
  const packet = buildMachineReadablePacket({
    conversation,
    variant,
    profile,
    generatedAt,
    objective,
    conversationState,
    mostRecentAnswer: latestAnswer,
    latestTurnState,
    settledFacts,
    decisionsMade,
    openQuestions,
    constraints,
    nextAction,
    runSettings,
    agreements,
    disagreements,
    attachmentContext,
    sourceProvenance,
    recentTurnSummaries,
    pins,
    run,
  });

  const machineReadableBody = `\`\`\`json\n${JSON.stringify(packet, null, 2)}\n\`\`\``;
  const priorityMap = PROFILE_SECTION_PRIORITIES[profile];
  const targetChars = VARIANT_CHAR_TARGETS[variant];
  const conversationStateSection = buildConversationStateSection(conversationState.state, latestTurn);

  const sections = [
    {
      title: 'Objective',
      kind: 'text',
      body: objective,
      priority: 110,
      essential: true,
    },
    {
      title: conversationStateSection.title,
      kind: 'text',
      body: conversationStateSection.body,
      priority: priorityMap.conversationState,
      essential: true,
    },
    latestAnswer
      ? {
        title: 'Most Recent Answer',
        kind: 'text',
        body: latestAnswer,
        priority: priorityMap.mostRecentAnswer,
        essential: true,
      }
      : {
        title: 'Latest Turn State',
        kind: 'text',
        body: latestTurnState || 'No completed answer was captured for the latest turn.',
        priority: priorityMap.mostRecentAnswer,
        essential: true,
      },
    {
      title: 'Settled Facts',
      kind: 'bullet',
      items: settledFacts.length > 0 ? settledFacts : ['No durable facts were extracted beyond the latest answer.'],
      maxItems: MAX_FACTS,
      priority: priorityMap.settledFacts,
      essential: true,
    },
    {
      title: 'Decisions Made',
      kind: 'bullet',
      items: decisionsMade.length > 0 ? decisionsMade : ['No explicit decision was extracted beyond the current packet structure.'],
      maxItems: MAX_DECISIONS,
      priority: priorityMap.decisionsMade,
      essential: true,
    },
    {
      title: 'Open Questions',
      kind: 'bullet',
      items: openQuestions,
      maxItems: MAX_OPEN_QUESTIONS,
      priority: priorityMap.openQuestions,
      essential: true,
    },
    {
      title: 'Constraints',
      kind: 'bullet',
      items: constraints.length > 0 ? constraints : ['Carry forward only the established context that materially affects the next response.'],
      maxItems: MAX_CONSTRAINTS,
      priority: priorityMap.constraints,
      essential: true,
    },
    {
      title: 'Next Action',
      kind: 'text',
      body: nextAction,
      priority: priorityMap.nextAction,
      essential: true,
    },
    {
      title: 'Run Settings',
      kind: 'bullet',
      items: runSettings,
      maxItems: 8,
      priority: priorityMap.runSettings,
      essential: false,
    },
    {
      title: 'Agreements',
      kind: 'bullet',
      items: agreements,
      maxItems: MAX_AGREEMENTS,
      priority: priorityMap.agreements,
      essential: false,
    },
    {
      title: 'Disagreements',
      kind: 'bullet',
      items: disagreements,
      maxItems: MAX_DISAGREEMENTS,
      priority: priorityMap.disagreements,
      essential: false,
    },
    {
      title: 'Attachment Context',
      kind: 'bullet',
      items: attachmentContext,
      maxItems: MAX_ATTACHMENTS,
      priority: priorityMap.attachmentContext,
      essential: false,
    },
    {
      title: 'Source Provenance',
      kind: 'bullet',
      items: sourceProvenance.map(formatSearchProvenanceItem),
      maxItems: MAX_PROVENANCE,
      priority: priorityMap.sourceProvenance,
      essential: false,
    },
    variant === TRANSFER_PACKET_VARIANT_EXTENDED
      ? {
        title: 'Recent Turn Summaries',
        kind: 'raw',
        body: recentTurnSummaries.join('\n\n'),
        priority: priorityMap.recentTurnSummaries,
        essential: false,
      }
      : null,
    {
      title: 'Machine Readable',
      kind: 'raw',
      body: machineReadableBody,
      priority: priorityMap.machineReadable,
      essential: false,
    },
  ]
    .filter(Boolean)
    .sort((left, right) => {
      if (left.essential !== right.essential) {
        return left.essential ? -1 : 1;
      }
      return (right.priority || 0) - (left.priority || 0);
    });

  const headerLines = [
    `# Transfer Packet (${variantLabel})`,
    '',
    `Conversation: ${normalizeInlineText(conversation?.title || 'Untitled chat') || 'Untitled chat'}`,
    generatedAt ? `Generated: ${generatedAt}` : '',
    `Profile: ${profileLabel}`,
    `Turns: ${turns.length}`,
    '',
    'Continue this discussion in another chat or LLM. Preserve the established facts, decisions, constraints, and evidence below instead of restarting from raw chat history.',
  ].filter(Boolean);
  const headerText = headerLines.join('\n');
  const packed = packSections(sections, Math.max(targetChars - headerText.length - 2, 1200));
  const text = `${headerText}\n\n${packed.text}`.trim();

  return {
    text,
    packet,
    meta: {
      variant,
      profile,
      targetChars,
      totalChars: text.length,
      approxTokens: estimateTokens(text),
      omittedSections: packed.omittedSections,
      warnings: packed.warnings,
    },
  };
}

export function buildConversationTransferPacket(conversation, options = {}) {
  return buildConversationTransferPacketBundle(conversation, options).text;
}

export function exportConversationTransferPacket(conversation, options = {}) {
  const packet = typeof options.contentOverride === 'string'
    ? options.contentOverride
    : buildConversationTransferPacket(conversation, options);
  const fileName = getPacketFilename(conversation, options);
  downloadTextFile(packet, fileName, 'text/markdown');
  return packet;
}

export function buildTransferPinsFromEditor({ settledFactsText = '', constraintsText = '' } = {}) {
  return {
    settledFacts: parseLinesToPins(settledFactsText),
    constraints: parseLinesToPins(constraintsText),
  };
}
