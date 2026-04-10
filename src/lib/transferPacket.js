import { buildTurnContextSummary } from './conversationIndex.js';

export const TRANSFER_PACKET_VARIANT_COMPACT = 'compact';
export const TRANSFER_PACKET_VARIANT_EXTENDED = 'extended';

const MAX_RECENT_TURNS = 3;
const MAX_RECENT_ATTACHMENTS = 6;
const COMPACT_ACTIVE_REQUEST_LIMIT = 700;
const EXTENDED_ACTIVE_REQUEST_LIMIT = 900;
const COMPACT_RUNNING_SUMMARY_LIMIT = 3200;
const EXTENDED_RUNNING_SUMMARY_LIMIT = 4200;
const COMPACT_LATEST_STATE_LIMIT = 1500;
const EXTENDED_LATEST_STATE_LIMIT = 2000;
const FALLBACK_EARLIER_TURN_LIMIT = 700;
const EXTENDED_RECENT_TURN_SUMMARY_LIMIT = 900;

function normalizeVariant(variant) {
  return variant === TRANSFER_PACKET_VARIANT_EXTENDED
    ? TRANSFER_PACKET_VARIANT_EXTENDED
    : TRANSFER_PACKET_VARIANT_COMPACT;
}

function formatIsoTimestamp(value) {
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

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(value, maxChars) {
  const safeText = normalizeText(value);
  if (!safeText) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || safeText.length <= maxChars) {
    return safeText;
  }
  return `${safeText.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getTurnSummary(turn, maxChars = Infinity) {
  const existingSummary = normalizeText(turn?.contextSummary);
  const summary = existingSummary || normalizeText(buildTurnContextSummary(turn));
  return truncateText(summary, maxChars);
}

function getTurnLatestState(turn, maxChars) {
  const synthesis = normalizeText(turn?.synthesis?.content);
  if (synthesis) {
    return truncateText(synthesis, maxChars);
  }

  const summary = getTurnSummary(turn, maxChars);
  if (summary) {
    return summary;
  }

  const searchContent = normalizeText(turn?.webSearchResult?.content);
  return truncateText(searchContent, maxChars);
}

function collectRecentAttachmentNames(turns) {
  const seen = new Set();
  const names = [];

  for (const turn of turns) {
    for (const attachment of turn?.attachments || []) {
      const name = String(attachment?.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= MAX_RECENT_ATTACHMENTS) {
        return names;
      }
    }
  }

  return names;
}

function buildEarlierContext(conversation, recentTurnCount, variant) {
  const runningSummary = normalizeText(conversation?.runningSummary);
  if (runningSummary) {
    return truncateText(
      runningSummary,
      variant === TRANSFER_PACKET_VARIANT_EXTENDED
        ? EXTENDED_RUNNING_SUMMARY_LIMIT
        : COMPACT_RUNNING_SUMMARY_LIMIT,
    );
  }

  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const olderTurns = turns.slice(0, Math.max(0, turns.length - recentTurnCount));
  if (olderTurns.length === 0) {
    return '';
  }

  return olderTurns
    .slice(-2)
    .map((turn, index) => {
      const turnNumber = olderTurns.length - Math.min(2, olderTurns.length) + index + 1;
      const summary = getTurnSummary(turn, FALLBACK_EARLIER_TURN_LIMIT);
      if (!summary) return '';
      return `Earlier turn ${turnNumber}:\n${summary}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildConstraintLines(conversation, recentTurns) {
  const latestTurn = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1] : null;
  const lines = [];

  if (latestTurn?.focusedMode === true) {
    lines.push('User preferred shorter, tighter replies.');
  }

  if (recentTurns.some((turn) => Boolean(turn?.webSearchEnabled) || turn?.webSearchResult?.status === 'complete')) {
    lines.push('Recent turns used web search or source-backed evidence; preserve that expectation for date-sensitive claims.');
  }

  const recentAttachmentNames = collectRecentAttachmentNames(recentTurns);
  if (recentAttachmentNames.length > 0) {
    lines.push(`Recent attachments referenced: ${recentAttachmentNames.join(', ')}.`);
  }

  if (latestTurn?.mode === 'debate') {
    lines.push('Prior answers came from a multi-model debate before synthesis.');
  } else if (latestTurn?.mode === 'parallel') {
    lines.push('Prior answers compared multiple models side by side.');
  } else if (latestTurn?.mode === 'direct') {
    lines.push('Prior answers used an ensemble-style merged response.');
  }

  const description = truncateText(conversation?.description, 220);
  if (description) {
    lines.push(`Conversation description: ${description}`);
  }

  return lines;
}

function buildRecentTurnSection(turn, turnNumber) {
  const lines = [];
  const prompt = truncateText(turn?.userPrompt, 500);
  const summary = getTurnSummary(turn, EXTENDED_RECENT_TURN_SUMMARY_LIMIT);

  lines.push(`### Turn ${turnNumber}`);
  lines.push('');

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
}

export function buildConversationTransferPacket(conversation, options = {}) {
  if (!conversation || typeof conversation !== 'object') return '';

  const variant = normalizeVariant(options.variant);
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const recentTurns = turns.slice(-Math.min(MAX_RECENT_TURNS, turns.length));
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const activeRequest = truncateText(
    latestTurn?.userPrompt || conversation?.description || conversation?.title || '',
    variant === TRANSFER_PACKET_VARIANT_EXTENDED
      ? EXTENDED_ACTIVE_REQUEST_LIMIT
      : COMPACT_ACTIVE_REQUEST_LIMIT,
  );
  const earlierContext = buildEarlierContext(conversation, recentTurns.length, variant);
  const latestState = latestTurn
    ? getTurnLatestState(
      latestTurn,
      variant === TRANSFER_PACKET_VARIANT_EXTENDED
        ? EXTENDED_LATEST_STATE_LIMIT
        : COMPACT_LATEST_STATE_LIMIT,
    )
    : '';
  const constraintLines = buildConstraintLines(conversation, recentTurns);
  const generatedAt = formatIsoTimestamp(options.generatedAt || Date.now());
  const variantLabel = variant === TRANSFER_PACKET_VARIANT_EXTENDED ? 'Extended' : 'Compact';
  const lines = [];

  lines.push(`# Transfer Packet (${variantLabel})`);
  lines.push('');
  lines.push(`Conversation: ${String(conversation?.title || 'Untitled chat').trim() || 'Untitled chat'}`);
  if (generatedAt) {
    lines.push(`Generated: ${generatedAt}`);
  }
  lines.push(`Turns: ${turns.length}`);
  lines.push('');
  lines.push('## Handoff');
  lines.push('');
  lines.push('Continue this discussion in another chat or LLM. Preserve the established facts, decisions, and constraints below, and treat the latest user request as the active task.');
  lines.push('');

  if (activeRequest) {
    lines.push('## Active Request');
    lines.push('');
    lines.push(activeRequest);
    lines.push('');
  }

  if (earlierContext) {
    lines.push('## Established Context');
    lines.push('');
    lines.push(earlierContext);
    lines.push('');
  }

  if (latestState) {
    lines.push('## Latest Answer State');
    lines.push('');
    lines.push(latestState);
    lines.push('');
  }

  if (constraintLines.length > 0) {
    lines.push('## Constraints and Preferences');
    lines.push('');
    for (const line of constraintLines) {
      lines.push(`- ${line}`);
    }
    lines.push('');
  }

  if (variant === TRANSFER_PACKET_VARIANT_EXTENDED && recentTurns.length > 0) {
    lines.push('## Recent Turn Summaries');
    lines.push('');
    recentTurns.forEach((turn, index) => {
      lines.push(buildRecentTurnSection(
        turn,
        turns.length - recentTurns.length + index + 1,
      ));
      if (index < recentTurns.length - 1) {
        lines.push('');
      }
      lines.push('');
    });
  }

  lines.push('## Next Step for the New Model');
  lines.push('');
  lines.push('Continue from the active request using the context above. Do not restart the conversation from scratch. If a required fact, source, or attachment is missing, ask one focused follow-up instead of re-deriving everything.');

  return lines.join('\n').trim();
}

export function exportConversationTransferPacket(conversation, options = {}) {
  const variant = normalizeVariant(options.variant);
  const packet = buildConversationTransferPacket(conversation, options);
  const dateStamp = new Date(options.generatedAt || Date.now()).toISOString().slice(0, 10);
  const fileName = `${sanitizeFileName(conversation?.title || 'conversation') || 'conversation'}-${dateStamp}-transfer-${variant}.md`;
  downloadTextFile(packet, fileName, 'text/markdown');
  return packet;
}
