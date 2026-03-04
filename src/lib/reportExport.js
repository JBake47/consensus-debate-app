import { computeConversationCostMeta, formatCostWithQuality } from './formatTokens';
import { extractCitations } from './citationInspector';
import { getModelDisplayName } from './openrouter';

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

function renderTurn(turn, index) {
  const lines = [];
  lines.push(`## Turn ${index + 1}`);
  lines.push('');
  lines.push(`- Mode: ${turn.mode || 'debate'}`);
  lines.push(`- Timestamp: ${formatIsoTimestamp(turn.timestamp) || 'unknown'}`);
  if (turn.debateMetadata) {
    lines.push(`- Total rounds: ${turn.debateMetadata.totalRounds ?? '-'}`);
    lines.push(`- Converged: ${turn.debateMetadata.converged ? 'yes' : 'no'}`);
    if (turn.debateMetadata.terminationReason) {
      lines.push(`- Ended: ${turn.debateMetadata.terminationReason}`);
    }
  }
  lines.push('');
  lines.push('### Prompt');
  lines.push('');
  lines.push(turn.userPrompt || '');
  lines.push('');

  if (Array.isArray(turn.rounds) && turn.rounds.length > 0) {
    for (const round of turn.rounds) {
      lines.push(`### ${round.label || `Round ${round.roundNumber || '?'}`}`);
      lines.push('');
      for (const stream of round.streams || []) {
        lines.push(`#### ${getModelDisplayName(stream.model || 'model')}`);
        lines.push('');
        lines.push(stream.content || stream.error || '_No content_');
        lines.push('');
      }
      if (round.convergenceCheck) {
        lines.push(`Convergence: ${round.convergenceCheck.converged ? 'yes' : 'no'}${round.convergenceCheck.reason ? ` - ${round.convergenceCheck.reason}` : ''}`);
        lines.push('');
      }
    }
  }

  if (turn.synthesis?.content) {
    lines.push('### Synthesis');
    lines.push('');
    lines.push(turn.synthesis.content);
    lines.push('');
  }

  const citations = [];
  for (const round of turn.rounds || []) {
    for (const stream of round.streams || []) {
      citations.push(...extractCitations(stream.content, stream.searchEvidence?.urls || []));
    }
  }
  if (turn.synthesis?.content) {
    citations.push(...extractCitations(turn.synthesis.content));
  }
  const uniqueCitations = Array.from(new Map(citations.map((item) => [item.url, item])).values());
  if (uniqueCitations.length > 0) {
    lines.push('### Citations');
    lines.push('');
    for (const citation of uniqueCitations) {
      lines.push(`- ${citation.domain || 'source'}: ${citation.url}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildConversationReport(conversation) {
  if (!conversation) return '';
  const costMeta = computeConversationCostMeta(conversation);
  const costLabel = formatCostWithQuality(costMeta) || 'Unknown';
  const lines = [];
  lines.push(`# ${conversation.title || 'Conversation Report'}`);
  lines.push('');
  if (conversation.description) {
    lines.push(conversation.description);
    lines.push('');
  }
  lines.push(`- Conversation ID: ${conversation.id || 'n/a'}`);
  lines.push(`- Created: ${formatIsoTimestamp(conversation.createdAt) || 'unknown'}`);
  lines.push(`- Updated: ${formatIsoTimestamp(conversation.updatedAt) || 'unknown'}`);
  lines.push(`- Turns: ${(conversation.turns || []).length}`);
  lines.push(`- Estimated Cost: ${costLabel}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  (conversation.turns || []).forEach((turn, index) => {
    lines.push(renderTurn(turn, index));
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n').trim();
}

export function downloadTextFile(content, filename, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportConversationReport(conversation) {
  const report = buildConversationReport(conversation);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const fileName = `${sanitizeFileName(conversation?.title || 'conversation') || 'conversation'}-${dateStamp}-report.md`;
  downloadTextFile(report, fileName, 'text/markdown');
  return report;
}
