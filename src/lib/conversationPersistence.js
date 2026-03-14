const BALANCED_ATTACHMENT_CONTENT_LIMIT = 64000;
const AGGRESSIVE_ATTACHMENT_CONTENT_LIMIT = 12000;
const BALANCED_REASONING_LIMIT = 80000;
const AGGRESSIVE_REASONING_LIMIT = 12000;
const BALANCED_WEB_SEARCH_CONTENT_LIMIT = 40000;
const AGGRESSIVE_WEB_SEARCH_CONTENT_LIMIT = 12000;
const BALANCED_RUNNING_SUMMARY_LIMIT = 120000;
const AGGRESSIVE_RUNNING_SUMMARY_LIMIT = 40000;
const BALANCED_IMAGE_DATA_URL_LIMIT = 350000;
const AGGRESSIVE_IMAGE_DATA_URL_LIMIT = 60000;

const PERSISTENCE_STRATEGIES = [
  {
    name: 'balanced',
    attachmentContentLimit: BALANCED_ATTACHMENT_CONTENT_LIMIT,
    reasoningLimit: BALANCED_REASONING_LIMIT,
    webSearchContentLimit: BALANCED_WEB_SEARCH_CONTENT_LIMIT,
    runningSummaryLimit: BALANCED_RUNNING_SUMMARY_LIMIT,
    imageDataUrlLimit: BALANCED_IMAGE_DATA_URL_LIMIT,
    keepAttachmentContent: true,
    keepReasoning: true,
  },
  {
    name: 'aggressive',
    attachmentContentLimit: AGGRESSIVE_ATTACHMENT_CONTENT_LIMIT,
    reasoningLimit: AGGRESSIVE_REASONING_LIMIT,
    webSearchContentLimit: AGGRESSIVE_WEB_SEARCH_CONTENT_LIMIT,
    runningSummaryLimit: AGGRESSIVE_RUNNING_SUMMARY_LIMIT,
    imageDataUrlLimit: AGGRESSIVE_IMAGE_DATA_URL_LIMIT,
    keepAttachmentContent: true,
    keepReasoning: true,
  },
  {
    name: 'minimal',
    attachmentContentLimit: 0,
    reasoningLimit: 0,
    webSearchContentLimit: 8000,
    runningSummaryLimit: 16000,
    imageDataUrlLimit: 0,
    keepAttachmentContent: false,
    keepReasoning: false,
  },
];

function truncateString(value, maxChars) {
  const text = typeof value === 'string' ? value : '';
  if (!text || maxChars <= 0 || text.length <= maxChars) {
    return maxChars <= 0 ? '' : text;
  }
  return text.slice(0, maxChars);
}

function mergeWarning(existing, next) {
  const parts = [existing, next]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(' ');
}

function compactAttachmentForPersistence(attachment, strategy) {
  if (!attachment || typeof attachment !== 'object') return attachment;

  const nextAttachment = { ...attachment };
  const category = String(attachment.category || '').toLowerCase();
  const isImage = category === 'image';
  const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '';

  if (isImage) {
    nextAttachment.content = '';
    if (!dataUrl || dataUrl.length > strategy.imageDataUrlLimit) {
      nextAttachment.dataUrl = null;
      nextAttachment.inlineWarning = mergeWarning(
        attachment.inlineWarning,
        'Preview was trimmed from saved chat history. Reattach the original file to view or resend it.',
      );
    }
  } else {
    nextAttachment.dataUrl = null;
    if (!strategy.keepAttachmentContent) {
      nextAttachment.content = '';
      nextAttachment.inlineWarning = mergeWarning(
        attachment.inlineWarning,
        'Original file contents were trimmed from saved chat history. Reattach the original file to resend it.',
      );
    } else if (typeof attachment.content === 'string') {
      nextAttachment.content = truncateString(attachment.content, strategy.attachmentContentLimit);
      if (nextAttachment.content.length < attachment.content.length) {
        nextAttachment.inlineWarning = mergeWarning(
          attachment.inlineWarning,
          'Saved preview was truncated to keep chat history persistent.',
        );
      }
    }
  }

  return nextAttachment;
}

function compactSearchResultForPersistence(result, strategy) {
  if (!result || typeof result !== 'object') return result;
  if (typeof result.content !== 'string') return result;
  return {
    ...result,
    content: truncateString(result.content, strategy.webSearchContentLimit),
  };
}

function compactStreamForPersistence(stream, strategy) {
  if (!stream || typeof stream !== 'object') return stream;
  const nextStream = { ...stream };
  if (strategy.keepReasoning) {
    if (typeof stream.reasoning === 'string') {
      nextStream.reasoning = truncateString(stream.reasoning, strategy.reasoningLimit);
    }
  } else {
    nextStream.reasoning = null;
  }
  return nextStream;
}

function compactTurnForPersistence(turn, strategy) {
  if (!turn || typeof turn !== 'object') return turn;

  return {
    ...turn,
    contextSummary: undefined,
    searchSections: undefined,
    attachments: Array.isArray(turn.attachments)
      ? turn.attachments.map((attachment) => compactAttachmentForPersistence(attachment, strategy))
      : turn.attachments,
    webSearchResult: compactSearchResultForPersistence(turn.webSearchResult, strategy),
    rounds: Array.isArray(turn.rounds)
      ? turn.rounds.map((round) => ({
        ...round,
        streams: Array.isArray(round?.streams)
          ? round.streams.map((stream) => compactStreamForPersistence(stream, strategy))
          : round?.streams,
      }))
      : turn.rounds,
  };
}

export function prepareConversationsForPersistence(conversations, strategyName = 'balanced') {
  const strategy = PERSISTENCE_STRATEGIES.find((candidate) => candidate.name === strategyName)
    || PERSISTENCE_STRATEGIES[0];

  return (Array.isArray(conversations) ? conversations : []).map((conversation) => ({
    ...conversation,
    sidebarData: undefined,
    runningSummary: truncateString(conversation?.runningSummary, strategy.runningSummaryLimit),
    turns: Array.isArray(conversation?.turns)
      ? conversation.turns.map((turn) => compactTurnForPersistence(turn, strategy))
      : [],
  }));
}

export function persistConversationsSnapshot(storage, key, conversations, options = {}) {
  if (!storage || typeof storage.setItem !== 'function' || !key) {
    return { ok: false, strategy: null, bytes: 0, error: new Error('Storage unavailable') };
  }

  const logger = options.logger || console;
  let lastError = null;

  for (const strategy of PERSISTENCE_STRATEGIES) {
    const payload = JSON.stringify(prepareConversationsForPersistence(conversations, strategy.name));
    try {
      storage.setItem(key, payload);
      return {
        ok: true,
        strategy: strategy.name,
        bytes: payload.length,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (typeof logger?.warn === 'function') {
    logger.warn('Failed to persist conversations after compaction attempts.', lastError);
  }

  return {
    ok: false,
    strategy: null,
    bytes: 0,
    error: lastError,
  };
}
