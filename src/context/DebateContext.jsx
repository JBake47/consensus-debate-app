import { createContext, useContext, useReducer, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  streamChat,
  chatCompletion,
  fetchModels,
  fetchCapabilities,
  DEFAULT_DEBATE_MODELS,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_CONVERGENCE_MODEL,
  DEFAULT_MAX_DEBATE_ROUNDS,
  DEFAULT_WEB_SEARCH_MODEL,
} from '../lib/openrouter';
import {
  buildRebuttalMessages,
  buildConvergenceMessages,
  buildMultiRoundSynthesisMessages,
  parseConvergenceResponse,
  createRound,
  getRoundLabel,
  buildEnsembleVoteMessages,
  buildEnsembleSynthesisMessages,
  parseEnsembleVoteResponse,
  getFocusedEnsembleAnalysisPrompt,
} from '../lib/debateEngine';
import {
  buildAttachmentMessagesForModels,
  buildAttachmentRoutingOverview,
  buildAttachmentTextContent,
} from '../lib/attachmentContent';
import {
  buildConversationContext,
  buildSummaryPrompt,
} from '../lib/contextManager';
import {
  buildConversationListItem,
  enrichConversationDerivedData,
  markConversationSummaryPending,
  markConversationSummaryProgress,
  updateConversationLastTurnDerivedData,
  updateConversationSidebarHeader,
} from '../lib/conversationIndex';
import { createSeedTitle, generateTitle } from '../lib/titleGenerator';
import {
  DEFAULT_RETRY_POLICY,
  normalizeRetryPolicy,
  isTransientRetryableError,
  getRetryDelayMs,
} from '../lib/retryPolicy';
import { buildResetSynthesisState } from '../lib/synthesisState';
import {
  buildSearchEvidence,
  canUseNativeWebSearch,
  getSearchResponseCachePolicy,
  shouldFallbackForMissingSearchEvidence,
} from '../lib/webSearch';
import { persistConversationsSnapshot } from '../lib/conversationPersistence';
import { applyThemeMode, getStoredThemeMode, normalizeThemeMode, THEME_STORAGE_KEY } from '../lib/theme';
import {
  createRunId,
  deriveRoundStatusFromStreams,
  getRoundRepairStreamIndices,
  selectReplacementModel,
} from '../lib/retryState';

const DebateActionContext = createContext(null);
const DebateSettingsContext = createContext(null);
const DebateUiContext = createContext(null);
const DebateConversationContext = createContext(null);
const DebateConversationListContext = createContext(null);

const RESPONSE_CACHE_TTL_MS = 2 * 60 * 1000;
const RESPONSE_CACHE_MAX_ENTRIES = 250;
const METRICS_SAMPLE_LIMIT = 120;
const CONVERSATIONS_STORAGE_KEY = 'debate_conversations';
const RESPONSE_CACHE_STORAGE_KEY = 'response_cache_store_v2';
const WEB_SEARCH_ENABLED_STORAGE_KEY = 'web_search_enabled';
const LEGACY_RESPONSE_CACHE_STORAGE_KEYS = ['response_cache_store_v1'];
const TITLE_SOURCE_SEED = 'seed';
const TITLE_SOURCE_AUTO = 'auto';
const TITLE_SOURCE_USER = 'user';
const DEFAULT_CONVERGENCE_ON_FINAL_ROUND = true;
const VALID_TITLE_SOURCES = new Set([TITLE_SOURCE_SEED, TITLE_SOURCE_AUTO, TITLE_SOURCE_USER]);
const STALE_RUN_ERROR_MESSAGE = 'Run interrupted before completion.';
const STALE_CONVERGENCE_REASON = 'Convergence check interrupted before completion.';

function normalizeTitleSource(value) {
  return VALID_TITLE_SOURCES.has(value) ? value : TITLE_SOURCE_SEED;
}

function createDefaultMetrics() {
  return {
    callCount: 0,
    successCount: 0,
    failureCount: 0,
    retryAttempts: 0,
    retryRecovered: 0,
    successfulTokenTotal: 0,
    firstAnswerTimes: [],
    failureByProvider: {},
    lastUpdated: Date.now(),
  };
}

function normalizeMetrics(raw) {
  const base = createDefaultMetrics();
  if (!raw || typeof raw !== 'object') return base;
  const firstAnswerTimes = Array.isArray(raw.firstAnswerTimes)
    ? raw.firstAnswerTimes
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .slice(-METRICS_SAMPLE_LIMIT)
    : [];
  const failureByProvider = raw.failureByProvider && typeof raw.failureByProvider === 'object'
    ? Object.fromEntries(
      Object.entries(raw.failureByProvider).map(([provider, value]) => {
        const parsed = Number(value);
        return [provider, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0];
      }).filter(([, value]) => value > 0)
    )
    : {};
  return {
    ...base,
    callCount: Number.isFinite(Number(raw.callCount)) ? Math.max(0, Math.floor(Number(raw.callCount))) : 0,
    successCount: Number.isFinite(Number(raw.successCount)) ? Math.max(0, Math.floor(Number(raw.successCount))) : 0,
    failureCount: Number.isFinite(Number(raw.failureCount)) ? Math.max(0, Math.floor(Number(raw.failureCount))) : 0,
    retryAttempts: Number.isFinite(Number(raw.retryAttempts)) ? Math.max(0, Math.floor(Number(raw.retryAttempts))) : 0,
    retryRecovered: Number.isFinite(Number(raw.retryRecovered)) ? Math.max(0, Math.floor(Number(raw.retryRecovered))) : 0,
    successfulTokenTotal: Number.isFinite(Number(raw.successfulTokenTotal))
      ? Math.max(0, Math.floor(Number(raw.successfulTokenTotal)))
      : 0,
    firstAnswerTimes,
    failureByProvider,
    lastUpdated: Number.isFinite(Number(raw.lastUpdated)) ? Number(raw.lastUpdated) : Date.now(),
  };
}

function loadFromStorage(key, defaultValue) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable
  }
}

function clearLegacyResponseCacheStorage() {
  if (typeof window === 'undefined') return;
  try {
    for (const key of LEGACY_RESPONSE_CACHE_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore storage access failures
  }
}

function hashCacheKeyPayload(value) {
  const input = String(value || '');
  let forward = 0x811c9dc5;
  let reverse = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    const nextCode = input.charCodeAt(index);
    forward ^= nextCode;
    forward = Math.imul(forward, 0x01000193);

    const reverseCode = input.charCodeAt(input.length - 1 - index);
    reverse ^= reverseCode;
    reverse = Math.imul(reverse, 0x01000193);
  }
  const forwardHex = (forward >>> 0).toString(16).padStart(8, '0');
  const reverseHex = (reverse >>> 0).toString(16).padStart(8, '0');
  return `${forwardHex}${reverseHex}`;
}

function shouldRunConvergenceCheck(roundNum, maxRounds, includeFinalRound) {
  if (!Number.isFinite(roundNum) || !Number.isFinite(maxRounds)) return false;
  if (roundNum < 2 || roundNum > maxRounds) return false;
  if (roundNum < maxRounds) return true;
  return Boolean(includeFinalRound) && roundNum === maxRounds;
}

clearLegacyResponseCacheStorage();

function loadPersistedResponseCache() {
  if (typeof window === 'undefined') return new Map();
  const raw = loadFromStorage(RESPONSE_CACHE_STORAGE_KEY, []);
  if (!Array.isArray(raw)) return new Map();
  const now = Date.now();
  const map = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || '');
    if (!key || !item.value) continue;
    const expiresAt = Number(item.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    map.set(key, {
      expiresAt,
      value: item.value,
    });
    if (map.size >= RESPONSE_CACHE_MAX_ENTRIES) break;
  }
  return map;
}

function persistResponseCache(cache) {
  try {
    const payload = Array.from(cache.entries())
      .slice(-RESPONSE_CACHE_MAX_ENTRIES)
      .map(([key, entry]) => ({
        key,
        expiresAt: entry?.expiresAt || 0,
        value: entry?.value || null,
      }));
    saveToStorage(RESPONSE_CACHE_STORAGE_KEY, payload);
  } catch {
    // noop
  }
}

/**
 * Migrate old turn format (flat streams[]) to new format (rounds[]).
 * Old: { userPrompt, streams[], synthesis }
 * New: { userPrompt, rounds[], synthesis, debateMetadata }
 */
function migrateTurn(turn) {
  if (turn.rounds) return turn; // already new format
  if (!turn.streams) return turn; // unknown format, leave as-is

  return {
    userPrompt: turn.userPrompt,
    rounds: [
      {
        roundNumber: 1,
        label: 'Initial Responses',
        status: 'complete',
        streams: turn.streams,
        convergenceCheck: null,
      },
    ],
    synthesis: turn.synthesis || null,
    debateMetadata: {
      totalRounds: 1,
      converged: false,
      terminationReason: 'legacy_single_round',
    },
  };
}

function recoverInterruptedTurnState(turn) {
  if (!turn || typeof turn !== 'object') {
    return { turn, changed: false };
  }

  let changed = false;
  let nextTurn = turn;

  if (turn.webSearchResult && isLiveStatus(turn.webSearchResult.status)) {
    nextTurn = {
      ...nextTurn,
      webSearchResult: {
        ...turn.webSearchResult,
        status: 'error',
        error: turn.webSearchResult.error || STALE_RUN_ERROR_MESSAGE,
      },
    };
    changed = true;
  }

  if (turn.ensembleResult && isLiveStatus(turn.ensembleResult.status)) {
    if (nextTurn === turn) nextTurn = { ...turn };
    nextTurn.ensembleResult = {
      ...turn.ensembleResult,
      status: 'error',
      error: turn.ensembleResult.error || STALE_RUN_ERROR_MESSAGE,
    };
    changed = true;
  }

  const synthesisStatus = turn.synthesis?.status;
  const isPendingWarmup = synthesisStatus === 'pending'
    && (!Array.isArray(turn.rounds) || turn.rounds.length === 0);
  if (
    turn.synthesis
    && (synthesisStatus === 'streaming' || synthesisStatus === 'searching' || synthesisStatus === 'analyzing' || isPendingWarmup)
  ) {
    if (nextTurn === turn) nextTurn = { ...turn };
    nextTurn.synthesis = {
      ...turn.synthesis,
      status: 'error',
      error: turn.synthesis.error || STALE_RUN_ERROR_MESSAGE,
      retryProgress: null,
    };
    changed = true;
  }

  if (Array.isArray(turn.rounds) && turn.rounds.length > 0) {
    let roundChanged = false;
    const nextRounds = turn.rounds.map((round) => {
      if (!round || typeof round !== 'object') return round;

      let nextRound = round;

      if (isLiveStatus(round.status)) {
        nextRound = { ...nextRound, status: 'error' };
      }

      if (Array.isArray(round.streams) && round.streams.length > 0) {
        let streamChanged = false;
        const nextStreams = round.streams.map((stream) => {
          if (!stream || typeof stream !== 'object') return stream;
          if (!isLiveStatus(stream.status)) return stream;
          streamChanged = true;
          const hasContent = typeof stream.content === 'string' && stream.content.trim().length > 0;
          return {
            ...stream,
            status: hasContent ? 'complete' : 'error',
            error: stream.error || STALE_RUN_ERROR_MESSAGE,
            errorKind: stream.errorKind || 'failed',
            outcome: hasContent ? 'using_previous_response' : (stream.outcome || null),
            retryProgress: null,
          };
        });
        if (streamChanged) {
          if (nextRound === round) nextRound = { ...round };
          nextRound.streams = nextStreams;
        }
      }

      if (nextRound.convergenceCheck && nextRound.convergenceCheck.converged == null) {
        if (nextRound === round) nextRound = { ...round };
        nextRound.convergenceCheck = {
          ...nextRound.convergenceCheck,
          converged: false,
          reason: nextRound.convergenceCheck.reason || STALE_CONVERGENCE_REASON,
        };
      }

      if (nextRound !== round) {
        roundChanged = true;
      }
      return nextRound;
    });

    if (roundChanged) {
      if (nextTurn === turn) nextTurn = { ...turn };
      nextTurn.rounds = nextRounds;
      changed = true;
    }
  }

  if (
    changed
    && turn.debateMetadata
    && (turn.debateMetadata.terminationReason == null || turn.debateMetadata.terminationReason === '')
  ) {
    if (nextTurn === turn) nextTurn = { ...turn };
    nextTurn.debateMetadata = {
      ...turn.debateMetadata,
      terminationReason: 'interrupted',
    };
  }

  return { turn: nextTurn, changed };
}

function migrateConversations(conversations) {
  let migrated = false;
  const result = conversations.map(conv => {
    const rawTurns = Array.isArray(conv.turns) ? conv.turns : [];
    if (!Array.isArray(conv.turns)) {
      migrated = true;
    }
    const turns = rawTurns.map(turn => {
      let nextTurn = turn;
      if (!turn.rounds && turn.streams) {
        migrated = true;
        nextTurn = migrateTurn(turn);
      }
      const recovered = recoverInterruptedTurnState(nextTurn);
      if (recovered.changed) {
        migrated = true;
        nextTurn = recovered.turn;
      }
      return nextTurn;
    });
    // Migrate updatedAt for existing conversations
    let updatedAt = conv.updatedAt;
    if (!updatedAt) {
      migrated = true;
      updatedAt = conv.createdAt || Date.now();
    }
    const titleSource = normalizeTitleSource(conv.titleSource);
    if (conv.titleSource !== titleSource) {
      migrated = true;
    }
    const titleLocked = typeof conv.titleLocked === 'boolean'
      ? conv.titleLocked
      : titleSource === TITLE_SOURCE_USER;
    if (conv.titleLocked !== titleLocked) {
      migrated = true;
    }
    let titleEditedAt = null;
    const rawTitleEditedAt = Number(conv.titleEditedAt);
    if (Number.isFinite(rawTitleEditedAt) && rawTitleEditedAt > 0) {
      titleEditedAt = Math.floor(rawTitleEditedAt);
    } else if (titleLocked) {
      titleEditedAt = updatedAt || conv.createdAt || Date.now();
    }
    if (conv.titleEditedAt !== titleEditedAt) {
      migrated = true;
    }
    const derivedConversation = enrichConversationDerivedData({
      ...conv,
      turns,
      updatedAt,
      titleSource,
      titleLocked,
      titleEditedAt,
    });
    if (
      conv.summarizedTurnCount !== derivedConversation.summarizedTurnCount
      || conv.pendingSummaryUntilTurnCount !== derivedConversation.pendingSummaryUntilTurnCount
      || conv.sidebarData == null
      || turns.some((turn, index) => turn !== derivedConversation.turns[index])
    ) {
      migrated = true;
    }
    return derivedConversation;
  });
  return { conversations: result, migrated };
}

const rawConversations = loadFromStorage(CONVERSATIONS_STORAGE_KEY, []);
const { conversations: migratedConversations, migrated } = migrateConversations(rawConversations);
if (migrated) {
  persistConversationsSnapshot(localStorage, CONVERSATIONS_STORAGE_KEY, migratedConversations);
}

const loadedMetrics = normalizeMetrics(loadFromStorage('debate_metrics', createDefaultMetrics()));
const loadedRetryPolicy = normalizeRetryPolicy(loadFromStorage('retry_policy', DEFAULT_RETRY_POLICY));
const loadedResponseCache = loadPersistedResponseCache();
const loadedBudgetSoftLimitRaw = Number(loadFromStorage('budget_soft_limit_usd', 1.5));
const loadedBudgetSoftLimit = Number.isFinite(loadedBudgetSoftLimitRaw)
  ? Math.max(0, loadedBudgetSoftLimitRaw)
  : 1.5;
const loadedBudgetAutoApproveRaw = Number(loadFromStorage('budget_auto_approve_below_usd', 0.5));
const loadedBudgetAutoApprove = Number.isFinite(loadedBudgetAutoApproveRaw)
  ? Math.max(0, loadedBudgetAutoApproveRaw)
  : 0.5;
const loadedVirtualizationKeepLatestRaw = Number(loadFromStorage('stream_virtualization_keep_latest', 4));
const loadedVirtualizationKeepLatest = Number.isFinite(loadedVirtualizationKeepLatestRaw)
  ? Math.max(2, Math.min(12, Math.floor(loadedVirtualizationKeepLatestRaw)))
  : 4;

const rememberApiKey = loadFromStorage('remember_api_key', false);
if (!rememberApiKey) {
  localStorage.removeItem('openrouter_api_key');
}

const initialState = {
  apiKey: rememberApiKey
    ? (localStorage.getItem('openrouter_api_key') || '')
    : (sessionStorage.getItem('openrouter_api_key') || ''),
  rememberApiKey,
  selectedModels: loadFromStorage('debate_models', DEFAULT_DEBATE_MODELS),
  synthesizerModel: loadFromStorage('synthesizer_model', DEFAULT_SYNTHESIZER_MODEL),
  convergenceModel: loadFromStorage('convergence_model', DEFAULT_CONVERGENCE_MODEL),
  convergenceOnFinalRound: loadFromStorage('convergence_on_final_round', DEFAULT_CONVERGENCE_ON_FINAL_ROUND) !== false,
  maxDebateRounds: loadFromStorage('max_debate_rounds', DEFAULT_MAX_DEBATE_ROUNDS),
  webSearchModel: loadFromStorage('web_search_model', DEFAULT_WEB_SEARCH_MODEL),
  strictWebSearch: loadFromStorage('strict_web_search', false),
  retryPolicy: loadedRetryPolicy,
  budgetGuardrailsEnabled: loadFromStorage('budget_guardrails_enabled', false),
  budgetSoftLimitUsd: loadedBudgetSoftLimit,
  budgetAutoApproveBelowUsd: loadedBudgetAutoApprove,
  smartRankingMode: loadFromStorage('smart_ranking_mode', 'balanced'),
  smartRankingPreferFlagship: loadFromStorage('smart_ranking_prefer_flagship', true),
  smartRankingPreferNew: loadFromStorage('smart_ranking_prefer_new', true),
  smartRankingAllowPreview: loadFromStorage('smart_ranking_allow_preview', true),
  streamVirtualizationEnabled: loadFromStorage('stream_virtualization_enabled', true),
  streamVirtualizationKeepLatest: loadedVirtualizationKeepLatest,
  cachePersistenceEnabled: loadFromStorage('cache_persistence_enabled', true),
  themeMode: getStoredThemeMode(),
  cacheHitCount: 0,
  cacheEntryCount: loadedResponseCache.size,
  chatMode: loadFromStorage('chat_mode', 'debate'),
  focusedMode: loadFromStorage('focused_mode', false),
  webSearchEnabled: loadFromStorage(WEB_SEARCH_ENABLED_STORAGE_KEY, true),
  modelPresets: loadFromStorage('model_presets', []),
  modelCatalog: {},
  modelCatalogStatus: 'idle',
  modelCatalogError: null,
  providerStatus: { openrouter: false, anthropic: false, openai: false, gemini: false },
  capabilityRegistry: null,
  providerStatusState: 'idle',
  providerStatusError: null,
  metrics: loadedMetrics,
  conversations: migratedConversations,
  activeConversationId: null,
  debateInProgress: false,
  showSettings: false,
  editingTurn: null,
};

function updateLastTurn(conversations, conversationId, updater, options = {}) {
  const { turnId = null, runId = null } = options || {};
  let changed = false;

  const nextConversations = conversations.map(c => {
    if (c.id !== conversationId) return c;
    const turns = Array.isArray(c.turns) ? [...c.turns] : [];
    if (turns.length === 0) return c;

    const lastTurn = { ...turns[turns.length - 1] };
    if (turnId && lastTurn.id !== turnId) return c;
    if (runId && lastTurn.activeRunId !== runId) return c;

    updater(lastTurn);
    turns[turns.length - 1] = lastTurn;
    changed = true;
    return updateConversationLastTurnDerivedData({ ...c, turns, updatedAt: Date.now() });
  });

  return changed ? nextConversations : conversations;
}

function buildScopedTurnPayload({ conversationId, turnId, runId, ...payload }) {
  return {
    conversationId,
    turnId,
    runId,
    ...payload,
  };
}

function getFailureCount(stream) {
  const parsed = Number(stream?.failureCount);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function getReplacementModelForStream(replacementModels, streamIndex) {
  if (!replacementModels || typeof replacementModels !== 'object') return null;
  const candidate = replacementModels[streamIndex];
  return typeof candidate === 'string' && candidate ? candidate : null;
}

function buildStreamRefreshState(previousStream, model, options = {}) {
  const previous = previousStream && typeof previousStream === 'object'
    ? previousStream
    : null;
  const preserveContent = Boolean(options.preserveContent);
  const previousContent = typeof previous?.content === 'string' ? previous.content : '';
  const keepPreviousContent = preserveContent && previousContent.trim().length > 0;

  return {
    model: model || previous?.model || '',
    content: keepPreviousContent ? previousContent : '',
    status: 'streaming',
    error: null,
    errorKind: null,
    outcome: keepPreviousContent ? (previous?.outcome || 'success') : null,
    usage: keepPreviousContent ? (previous?.usage ?? null) : null,
    durationMs: keepPreviousContent ? (previous?.durationMs ?? null) : null,
    reasoning: keepPreviousContent ? (previous?.reasoning ?? null) : null,
    searchEvidence: keepPreviousContent ? (previous?.searchEvidence ?? null) : null,
    routeInfo: options.routeInfo ?? previous?.routeInfo ?? null,
    cacheHit: false,
    completedAt: keepPreviousContent ? (previous?.completedAt ?? null) : null,
    retryProgress: null,
  };
}

function buildPreviousResponseFallback(previousStream, options = {}) {
  const previous = previousStream && typeof previousStream === 'object'
    ? previousStream
    : null;
  const previousContent = typeof previous?.content === 'string' ? previous.content : '';
  if (previousContent.trim().length === 0) {
    return null;
  }

  return {
    model: options.model || previous?.model || '',
    content: previousContent,
    status: 'complete',
    error: options.error || 'Retry failed - showing previous response.',
    errorKind: options.errorKind || 'failed',
    outcome: 'using_previous_response',
    usage: previous?.usage ?? options.usage ?? null,
    durationMs: previous?.durationMs ?? options.durationMs ?? null,
    reasoning: previous?.reasoning ?? options.reasoning ?? null,
    searchEvidence: previous?.searchEvidence ?? options.searchEvidence ?? null,
    routeInfo: options.routeInfo ?? previous?.routeInfo ?? null,
    cacheHit: Boolean(previous?.cacheHit),
    completedAt: previous?.completedAt ?? null,
    retryProgress: null,
  };
}

function toSynthesisStream(stream) {
  if (!stream?.model || !stream?.content) return null;
  return {
    model: stream.model,
    content: stream.content,
    status: 'complete',
  };
}

function buildTitleSynthesisContextFromStreams(streams) {
  if (!Array.isArray(streams) || streams.length === 0) return '';
  return streams
    .filter((stream) => stream?.content)
    .slice(0, 3)
    .map((stream, index) => {
      const modelName = String(stream.model || `model-${index + 1}`);
      const snippet = String(stream.content || '').slice(0, 450).trim();
      if (!snippet) return '';
      return `${modelName}: ${snippet}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function toSynthesisRound(round) {
  if (!round) return null;
  const streams = (round.streams || []).map(toSynthesisStream).filter(Boolean);
  if (streams.length === 0) return null;
  return {
    label: round.label || `Round ${round.roundNumber || 1}`,
    streams,
    convergenceCheck: round.convergenceCheck || null,
  };
}

function toSynthesisRounds(rounds, count = rounds?.length || 0) {
  return (rounds || [])
    .slice(0, count)
    .map(toSynthesisRound)
    .filter(Boolean);
}

function buildSynthesisRoundSummary({ label, roundNumber, streams, convergenceCheck = null }) {
  const synthesisStreams = (streams || []).map(toSynthesisStream).filter(Boolean);
  if (synthesisStreams.length === 0) return null;
  return {
    label: label || `Round ${roundNumber || 1}`,
    streams: synthesisStreams,
    convergenceCheck: convergenceCheck || null,
  };
}

function getModelProviderId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw.includes(':')) {
    const prefix = raw.split(':')[0];
    return prefix === 'google' ? 'gemini' : prefix;
  }
  const prefix = raw.split('/')[0];
  return prefix === 'google' ? 'gemini' : prefix;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function trimSample(values, limit = METRICS_SAMPLE_LIMIT) {
  if (!Array.isArray(values)) return [];
  return values.slice(-limit);
}

function computeWordSetSimilarity(a, b) {
  const tokenize = (text) => String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const aSet = new Set(tokenize(a));
  const bSet = new Set(tokenize(b));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(aSet.size, bSet.size);
}

function isLiveStatus(status) {
  return status === 'streaming' || status === 'pending' || status === 'searching' || status === 'analyzing';
}

function isTurnActivelyRunning(turn) {
  if (!turn || typeof turn !== 'object') return false;

  const webSearchStatus = turn.webSearchResult?.status;
  if (isLiveStatus(webSearchStatus)) return true;

  const ensembleStatus = turn.ensembleResult?.status;
  if (isLiveStatus(ensembleStatus)) return true;

  const synthesisStatus = turn.synthesis?.status;
  if (synthesisStatus === 'streaming') return true;

  const rounds = Array.isArray(turn.rounds) ? turn.rounds : [];
  if (rounds.length > 0) {
    for (const round of rounds) {
      if (isLiveStatus(round?.status)) return true;
      const streams = Array.isArray(round?.streams) ? round.streams : [];
      for (const stream of streams) {
        if (isLiveStatus(stream?.status)) return true;
      }
    }
  }

  // Warm-up window before the first round stream begins.
  if (synthesisStatus === 'pending' && rounds.length === 0) {
    return true;
  }

  return false;
}

function isConversationActivelyRunning(conversation) {
  if (!conversation || !Array.isArray(conversation.turns) || conversation.turns.length === 0) {
    return false;
  }
  const lastTurn = conversation.turns[conversation.turns.length - 1];
  return isTurnActivelyRunning(lastTurn);
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_API_KEY': {
      sessionStorage.setItem('openrouter_api_key', action.payload);
      if (state.rememberApiKey) {
        localStorage.setItem('openrouter_api_key', action.payload);
      } else {
        localStorage.removeItem('openrouter_api_key');
      }
      return { ...state, apiKey: action.payload };
    }
    case 'SET_REMEMBER_API_KEY': {
      saveToStorage('remember_api_key', action.payload);
      if (action.payload) {
        if (state.apiKey) {
          localStorage.setItem('openrouter_api_key', state.apiKey);
        }
      } else {
        localStorage.removeItem('openrouter_api_key');
      }
      return { ...state, rememberApiKey: action.payload };
    }
    case 'SET_MODELS': {
      saveToStorage('debate_models', action.payload);
      return { ...state, selectedModels: action.payload };
    }
    case 'ADD_MODEL_PRESET': {
      const name = action.payload.name.trim();
      if (!name) return state;
      const models = Array.isArray(action.payload.models) ? action.payload.models : [];
      const normalized = name.toLowerCase();
      const existing = state.modelPresets.find(p => p.name.toLowerCase() === normalized);
      const preset = {
        id: existing?.id || action.payload.id || Date.now().toString(),
        name,
        models,
        synthesizerModel: action.payload.synthesizerModel || state.synthesizerModel,
        convergenceModel: action.payload.convergenceModel || state.convergenceModel,
        maxDebateRounds: Number.isFinite(action.payload.maxDebateRounds)
          ? action.payload.maxDebateRounds
          : state.maxDebateRounds,
        webSearchModel: action.payload.webSearchModel || state.webSearchModel,
        updatedAt: Date.now(),
      };
      const next = [
        preset,
        ...state.modelPresets.filter(p => p.id !== preset.id),
      ];
      saveToStorage('model_presets', next);
      return { ...state, modelPresets: next };
    }
    case 'UPDATE_MODEL_PRESET': {
      const presetId = action.payload.id;
      if (!presetId) return state;
      const existing = state.modelPresets.find(p => p.id === presetId);
      if (!existing) return state;

      const name = action.payload.name.trim();
      if (!name) return state;
      const models = Array.isArray(action.payload.models) ? action.payload.models : [];
      const normalized = name.toLowerCase();

      const updatedPreset = {
        ...existing,
        name,
        models,
        synthesizerModel: action.payload.synthesizerModel || state.synthesizerModel,
        convergenceModel: action.payload.convergenceModel || state.convergenceModel,
        maxDebateRounds: Number.isFinite(action.payload.maxDebateRounds)
          ? action.payload.maxDebateRounds
          : state.maxDebateRounds,
        webSearchModel: action.payload.webSearchModel || state.webSearchModel,
        updatedAt: Date.now(),
      };

      const deduped = state.modelPresets.filter(p => p.id === presetId || p.name.toLowerCase() !== normalized);
      const next = deduped.map(p => (p.id === presetId ? updatedPreset : p));
      saveToStorage('model_presets', next);
      return { ...state, modelPresets: next };
    }
    case 'DELETE_MODEL_PRESET': {
      const next = state.modelPresets.filter(p => p.id !== action.payload);
      saveToStorage('model_presets', next);
      return { ...state, modelPresets: next };
    }
    case 'SET_SYNTHESIZER': {
      saveToStorage('synthesizer_model', action.payload);
      return { ...state, synthesizerModel: action.payload };
    }
    case 'SET_CONVERGENCE_MODEL': {
      saveToStorage('convergence_model', action.payload);
      return { ...state, convergenceModel: action.payload };
    }
    case 'SET_CONVERGENCE_ON_FINAL_ROUND': {
      const enabled = Boolean(action.payload);
      saveToStorage('convergence_on_final_round', enabled);
      return { ...state, convergenceOnFinalRound: enabled };
    }
    case 'SET_MAX_DEBATE_ROUNDS': {
      saveToStorage('max_debate_rounds', action.payload);
      return { ...state, maxDebateRounds: action.payload };
    }
    case 'SET_WEB_SEARCH_MODEL': {
      saveToStorage('web_search_model', action.payload);
      return { ...state, webSearchModel: action.payload };
    }
    case 'SET_STRICT_WEB_SEARCH': {
      saveToStorage('strict_web_search', action.payload);
      return { ...state, strictWebSearch: action.payload };
    }
    case 'SET_RETRY_POLICY': {
      const policy = normalizeRetryPolicy(action.payload);
      saveToStorage('retry_policy', policy);
      return { ...state, retryPolicy: policy };
    }
    case 'SET_BUDGET_GUARDRAILS_ENABLED': {
      saveToStorage('budget_guardrails_enabled', action.payload);
      return { ...state, budgetGuardrailsEnabled: Boolean(action.payload) };
    }
    case 'SET_BUDGET_SOFT_LIMIT_USD': {
      const value = Number(action.payload);
      const normalized = Number.isFinite(value) ? Math.max(0, value) : 0;
      saveToStorage('budget_soft_limit_usd', normalized);
      return { ...state, budgetSoftLimitUsd: normalized };
    }
    case 'SET_BUDGET_AUTO_APPROVE_BELOW_USD': {
      const value = Number(action.payload);
      const normalized = Number.isFinite(value) ? Math.max(0, value) : 0;
      saveToStorage('budget_auto_approve_below_usd', normalized);
      return { ...state, budgetAutoApproveBelowUsd: normalized };
    }
    case 'SET_SMART_RANKING_MODE': {
      const allowed = new Set(['balanced', 'fast', 'cheap', 'quality', 'frontier']);
      const mode = allowed.has(action.payload) ? action.payload : 'balanced';
      saveToStorage('smart_ranking_mode', mode);
      return { ...state, smartRankingMode: mode };
    }
    case 'SET_SMART_RANKING_PREFER_FLAGSHIP': {
      const enabled = Boolean(action.payload);
      saveToStorage('smart_ranking_prefer_flagship', enabled);
      return { ...state, smartRankingPreferFlagship: enabled };
    }
    case 'SET_SMART_RANKING_PREFER_NEW': {
      const enabled = Boolean(action.payload);
      saveToStorage('smart_ranking_prefer_new', enabled);
      return { ...state, smartRankingPreferNew: enabled };
    }
    case 'SET_SMART_RANKING_ALLOW_PREVIEW': {
      const enabled = Boolean(action.payload);
      saveToStorage('smart_ranking_allow_preview', enabled);
      return { ...state, smartRankingAllowPreview: enabled };
    }
    case 'SET_STREAM_VIRTUALIZATION_ENABLED': {
      saveToStorage('stream_virtualization_enabled', action.payload);
      return { ...state, streamVirtualizationEnabled: Boolean(action.payload) };
    }
    case 'SET_STREAM_VIRTUALIZATION_KEEP_LATEST': {
      const value = Number(action.payload);
      const normalized = Number.isFinite(value)
        ? Math.max(2, Math.min(12, Math.floor(value)))
        : 4;
      saveToStorage('stream_virtualization_keep_latest', normalized);
      return { ...state, streamVirtualizationKeepLatest: normalized };
    }
    case 'SET_CACHE_PERSISTENCE_ENABLED': {
      const enabled = Boolean(action.payload);
      saveToStorage('cache_persistence_enabled', enabled);
      return { ...state, cachePersistenceEnabled: enabled };
    }
    case 'SET_THEME_MODE': {
      const mode = normalizeThemeMode(action.payload);
      saveToStorage(THEME_STORAGE_KEY, mode);
      return { ...state, themeMode: mode };
    }
    case 'SET_CACHE_STATS': {
      return {
        ...state,
        cacheHitCount: Number.isFinite(Number(action.payload?.cacheHitCount))
          ? Math.max(0, Math.floor(Number(action.payload.cacheHitCount)))
          : state.cacheHitCount,
        cacheEntryCount: Number.isFinite(Number(action.payload?.cacheEntryCount))
          ? Math.max(0, Math.floor(Number(action.payload.cacheEntryCount)))
          : state.cacheEntryCount,
      };
    }
    case 'CLEAR_RESPONSE_CACHE': {
      localStorage.removeItem(RESPONSE_CACHE_STORAGE_KEY);
      return {
        ...state,
        cacheHitCount: 0,
        cacheEntryCount: 0,
      };
    }
    case 'SET_WEB_SEARCH_ENABLED': {
      saveToStorage(WEB_SEARCH_ENABLED_STORAGE_KEY, action.payload);
      return { ...state, webSearchEnabled: action.payload };
    }
    case 'SET_CHAT_MODE': {
      saveToStorage('chat_mode', action.payload);
      return { ...state, chatMode: action.payload };
    }
    case 'SET_FOCUSED_MODE': {
      saveToStorage('focused_mode', action.payload);
      return { ...state, focusedMode: action.payload };
    }
    case 'SET_WEB_SEARCH_RESULT': {
      const { conversationId, turnId, runId, result } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.webSearchResult = result;
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'SET_MODEL_CATALOG': {
      return { ...state, modelCatalog: action.payload };
    }
    case 'SET_MODEL_CATALOG_STATUS': {
      return {
        ...state,
        modelCatalogStatus: action.payload.status,
        modelCatalogError: action.payload.error || null,
      };
    }
    case 'SET_PROVIDER_STATUS': {
      return { ...state, providerStatus: action.payload };
    }
    case 'SET_CAPABILITY_REGISTRY': {
      return { ...state, capabilityRegistry: action.payload || null };
    }
    case 'SET_PROVIDER_STATUS_STATE': {
      return {
        ...state,
        providerStatusState: action.payload.status,
        providerStatusError: action.payload.error || null,
      };
    }
    case 'SET_METRICS': {
      const metrics = normalizeMetrics(action.payload);
      return { ...state, metrics };
    }
    case 'SET_ACTIVE_CONVERSATION': {
      return { ...state, activeConversationId: action.payload };
    }
    case 'NEW_CONVERSATION': {
      const conv = enrichConversationDerivedData({
        id: action.payload.id,
        title: action.payload.title || 'New Debate',
        titleSource: normalizeTitleSource(action.payload.titleSource || TITLE_SOURCE_SEED),
        titleLocked: Boolean(action.payload.titleLocked),
        titleEditedAt: action.payload.titleEditedAt || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: [],
      });
      const conversations = [conv, ...state.conversations];
      return { ...state, conversations, activeConversationId: conv.id };
    }
    case 'ADD_TURN': {
      const convId = action.payload.conversationId || state.activeConversationId;
      const conversations = state.conversations.map(c =>
        c.id === convId
          ? updateConversationLastTurnDerivedData({
            ...c,
            turns: [...c.turns, action.payload.turn],
            updatedAt: Date.now(),
          })
          : c
      );
      return { ...state, conversations };
    }
    case 'SET_TURN_RUN_STATE': {
      const { conversationId, turnId, runId } = action.payload || {};
      if (!conversationId || !turnId || !runId) {
        return state;
      }
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.activeRunId = runId;
      }, { turnId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'ADD_ROUND': {
      const { conversationId, turnId, runId, round } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.rounds = [...(lastTurn.rounds || []), round];
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'UPDATE_ROUND_STREAM': {
      const {
        conversationId,
        turnId,
        runId,
        roundIndex,
        streamIndex,
        model,
        content,
        status,
        error,
        errorKind,
        outcome,
        usage,
        durationMs,
        completedAt,
        reasoning,
        searchEvidence,
        routeInfo,
        retryProgress,
        failureCount,
        cacheHit,
      } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const rounds = [...lastTurn.rounds];
        const round = { ...rounds[roundIndex] };
        const streams = [...round.streams];
        const previousStream = streams[streamIndex] || {};
        const updates = { ...previousStream, status, error };
        if (model !== undefined) updates.model = model;
        if (content !== undefined) updates.content = content;
        if (errorKind !== undefined) updates.errorKind = errorKind;
        if (outcome !== undefined) updates.outcome = outcome;
        if (usage !== undefined) updates.usage = usage;
        if (durationMs !== undefined) updates.durationMs = durationMs;
        if (completedAt !== undefined) updates.completedAt = completedAt;
        if (reasoning !== undefined) updates.reasoning = reasoning;
        if (searchEvidence !== undefined) updates.searchEvidence = searchEvidence;
        if (routeInfo !== undefined) updates.routeInfo = routeInfo;
        if (retryProgress !== undefined) updates.retryProgress = retryProgress;
        if (cacheHit !== undefined) updates.cacheHit = cacheHit;
        if (failureCount !== undefined) {
          updates.failureCount = failureCount;
        } else if (status !== 'streaming' && status !== 'pending' && error) {
          updates.failureCount = getFailureCount(previousStream) + 1;
        }
        if (status === 'complete' && completedAt === undefined && !error) {
          updates.completedAt = Date.now();
        }
        streams[streamIndex] = updates;
        round.streams = streams;
        round.status = deriveRoundStatusFromStreams(streams, round.status);
        rounds[roundIndex] = round;
        lastTurn.rounds = rounds;
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'UPDATE_ROUND_STATUS': {
      const { conversationId, turnId, runId, roundIndex, status } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const rounds = [...lastTurn.rounds];
        const round = { ...rounds[roundIndex] };
        round.status = status === 'complete' || status === 'error'
          ? deriveRoundStatusFromStreams(round.streams || [], status)
          : status;
        rounds[roundIndex] = round;
        lastTurn.rounds = rounds;
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'SET_CONVERGENCE': {
      const { conversationId, turnId, runId, roundIndex, convergenceCheck } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const rounds = [...lastTurn.rounds];
        rounds[roundIndex] = { ...rounds[roundIndex], convergenceCheck };
        lastTurn.rounds = rounds;
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'SET_DEBATE_METADATA': {
      const { conversationId, turnId, runId, metadata } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.debateMetadata = metadata;
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'SET_ENSEMBLE_RESULT': {
      const { conversationId, turnId, runId, ensembleResult } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.ensembleResult = ensembleResult;
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'SET_RUNNING_SUMMARY': {
      const {
        conversationId,
        summary,
        summarizedTurnCount,
        expectedCurrentPendingTurnCount,
      } = action.payload;
      const conversations = state.conversations.map(c =>
        c.id === conversationId
          ? markConversationSummaryProgress(
            c,
            summary,
            summarizedTurnCount,
            expectedCurrentPendingTurnCount,
          )
          : c
      );
      return { ...state, conversations };
    }
    case 'SET_RUNNING_SUMMARY_PENDING': {
      const { conversationId, pendingTurnCount, expectedCurrentPendingTurnCount } = action.payload;
      const conversations = state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? markConversationSummaryPending(conversation, pendingTurnCount, expectedCurrentPendingTurnCount)
          : conversation
      );
      return { ...state, conversations };
    }
    case 'UPDATE_SYNTHESIS': {
      const {
        conversationId,
        turnId,
        runId,
        content,
        status,
        error,
        model,
        usage,
        durationMs,
        retryProgress,
      } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const completedAt = status === 'complete'
          ? Date.now()
          : (action.payload.completedAt !== undefined
            ? action.payload.completedAt
            : (lastTurn.synthesis?.completedAt || null));
        const synth = { model, content, status, error, completedAt };
        if (usage !== undefined) synth.usage = usage;
        if (durationMs !== undefined) synth.durationMs = durationMs;
        if (retryProgress !== undefined) synth.retryProgress = retryProgress;
        lastTurn.synthesis = synth;
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'SET_CONVERSATION_TITLE': {
      const { conversationId, title, source, requestedAt } = action.payload || {};
      const normalizedTitle = typeof title === 'string' ? title.trim() : '';
      if (!conversationId || !normalizedTitle) {
        return state;
      }

      const normalizedSource = normalizeTitleSource(source || TITLE_SOURCE_USER);
      const requestTs = Number.isFinite(Number(requestedAt))
        ? Number(requestedAt)
        : Date.now();
      const now = Date.now();
      let changed = false;

      const conversations = state.conversations.map(c => {
        if (c.id !== conversationId) return c;

        const existingSource = normalizeTitleSource(c.titleSource);
        const existingLocked = typeof c.titleLocked === 'boolean'
          ? c.titleLocked
          : existingSource === TITLE_SOURCE_USER;
        const editedAt = Number.isFinite(Number(c.titleEditedAt))
          ? Number(c.titleEditedAt)
          : 0;

        if (normalizedSource === TITLE_SOURCE_AUTO) {
          if (existingLocked || existingSource === TITLE_SOURCE_USER) {
            return c;
          }
          if (requestTs < editedAt) {
            return c;
          }
        }

        if (
          c.title === normalizedTitle
          && (
            (normalizedSource === TITLE_SOURCE_USER
              && existingSource === TITLE_SOURCE_USER
              && existingLocked)
            || (normalizedSource !== TITLE_SOURCE_USER
              && existingSource === normalizedSource
              && !existingLocked)
          )
        ) {
          return c;
        }

        const nextConversation = normalizedSource === TITLE_SOURCE_USER
          ? {
            ...c,
            title: normalizedTitle,
            titleSource: TITLE_SOURCE_USER,
            titleLocked: true,
            titleEditedAt: now,
            updatedAt: now,
          }
          : {
            ...c,
            title: normalizedTitle,
            titleSource: normalizedSource,
            titleLocked: false,
              updatedAt: now,
            };

        changed = true;
        return updateConversationSidebarHeader(nextConversation);
      });

      if (!changed) {
        return state;
      }
      return { ...state, conversations };
    }
    case 'SET_CONVERSATION_DESCRIPTION': {
      const { conversationId, description } = action.payload;
      const conversations = state.conversations.map(c =>
        c.id === conversationId
          ? updateConversationSidebarHeader({ ...c, description, updatedAt: Date.now() })
          : c
      );
      return { ...state, conversations };
    }
    case 'DELETE_CONVERSATION': {
      const conversations = state.conversations.filter(c => c.id !== action.payload);
      const activeConversationId = state.activeConversationId === action.payload
        ? null
        : state.activeConversationId;
      return { ...state, conversations, activeConversationId };
    }
    case 'IMPORT_CONVERSATIONS': {
      const imported = action.payload;
      const existingIds = new Set(state.conversations.map(c => c.id));
      const newConvs = imported.filter(c => !existingIds.has(c.id));
      if (newConvs.length === 0) return state;
      const { conversations: migratedNew } = migrateConversations(newConvs);
      const conversations = [...migratedNew, ...state.conversations];
      return { ...state, conversations };
    }
    case 'RECOVER_INTERRUPTED_RUNS': {
      const { conversations, migrated } = migrateConversations(state.conversations);
      if (!migrated) return state;
      return { ...state, conversations };
    }
    case 'BRANCH_FROM_ROUND': {
      const { conversationId, roundIndex } = action.payload || {};
      const sourceConversation = state.conversations.find((conversation) => conversation.id === conversationId);
      if (!sourceConversation || !Array.isArray(sourceConversation.turns) || sourceConversation.turns.length === 0) {
        return state;
      }
      const sourceLastTurn = sourceConversation.turns[sourceConversation.turns.length - 1];
      const sourceRounds = Array.isArray(sourceLastTurn?.rounds) ? sourceLastTurn.rounds : [];
      if (sourceRounds.length === 0) return state;

      const keepCount = Math.max(1, Math.min(sourceRounds.length, Math.floor(Number(roundIndex)) + 1));
      const branchedRounds = sourceRounds.slice(0, keepCount).map((round) => ({
        ...round,
        streams: (round.streams || []).map((stream) => ({ ...stream })),
      }));

      const branchTurn = {
        ...sourceLastTurn,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        rounds: branchedRounds,
        synthesis: {
          model: state.synthesizerModel || sourceLastTurn.synthesis?.model || '',
          content: '',
          status: 'pending',
          error: null,
        },
        ensembleResult: sourceLastTurn.mode === 'direct' ? null : sourceLastTurn.ensembleResult || null,
        debateMetadata: {
          totalRounds: keepCount,
          converged: false,
          terminationReason: 'branch_checkpoint',
        },
      };

      const branchConversationId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const branchConversation = enrichConversationDerivedData({
        ...sourceConversation,
        id: branchConversationId,
        title: `${sourceConversation.title || 'Debate'} (Branch R${keepCount})`,
        titleSource: TITLE_SOURCE_SEED,
        titleLocked: false,
        titleEditedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentConversationId: sourceConversation.id,
        branchedFrom: {
          roundIndex: keepCount - 1,
          sourceTurnId: sourceLastTurn.id || null,
        },
        turns: [...sourceConversation.turns.slice(0, -1), branchTurn],
      });

      const conversations = [branchConversation, ...state.conversations];
      return { ...state, conversations, activeConversationId: branchConversationId };
    }
    case 'SET_DEBATE_IN_PROGRESS': {
      return { ...state, debateInProgress: action.payload };
    }
    case 'TOGGLE_SETTINGS': {
      return { ...state, showSettings: !state.showSettings };
    }
    case 'SET_SHOW_SETTINGS': {
      return { ...state, showSettings: action.payload };
    }
    case 'SET_EDITING_TURN': {
      return { ...state, editingTurn: action.payload };
    }
    case 'REMOVE_LAST_TURN': {
      const convId = action.payload;
      const conversations = state.conversations.map(c => {
        if (c.id !== convId) return c;
        const turns = c.turns.slice(0, -1);
        return enrichConversationDerivedData({ ...c, turns, updatedAt: Date.now() });
      });
      return { ...state, conversations };
    }
    case 'TRUNCATE_ROUNDS': {
      const { conversationId, turnId, runId, keepCount } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.rounds = lastTurn.rounds.slice(0, keepCount);
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    case 'RESET_SYNTHESIS': {
      const { conversationId, turnId, runId, model, preserveContent = false } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.synthesis = buildResetSynthesisState(lastTurn.synthesis, model, { preserveContent });
      }, { turnId, runId });
      return conversations === state.conversations ? state : { ...state, conversations };
    }
    default:
      return state;
  }
}

export function DebateProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const abortControllersRef = useRef(new Map());
  const responseCacheRef = useRef(loadedResponseCache);
  const providerCircuitRef = useRef({});
  const conversationsRef = useRef(state.conversations);
  const metricsRef = useRef(state.metrics);
  const cacheStatsRef = useRef({
    cacheHitCount: state.cacheHitCount,
    cacheEntryCount: state.cacheEntryCount,
  });
  const dispatchTurnScoped = useCallback((scope, type, payload = {}) => {
    dispatch({
      type,
      payload: buildScopedTurnPayload({
        ...(scope || {}),
        ...(payload || {}),
      }),
    });
  }, [dispatch]);

  useEffect(() => {
    applyThemeMode(state.themeMode);
  }, [state.themeMode]);

  useEffect(() => {
    dispatch({ type: 'RECOVER_INTERRUPTED_RUNS' });
  }, [dispatch]);

  useEffect(() => {
    conversationsRef.current = state.conversations;
  }, [state.conversations]);

  useEffect(() => {
    metricsRef.current = state.metrics;
  }, [state.metrics]);

  useEffect(() => {
    cacheStatsRef.current = {
      cacheHitCount: state.cacheHitCount,
      cacheEntryCount: state.cacheEntryCount,
    };
  }, [state.cacheHitCount, state.cacheEntryCount]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (state.conversations.some((conversation) => isConversationActivelyRunning(conversation))) {
      return undefined;
    }

    let timeoutId = 0;
    let idleId = 0;
    const flushSnapshot = () => {
      persistConversationsSnapshot(window.localStorage, CONVERSATIONS_STORAGE_KEY, conversationsRef.current);
    };

    timeoutId = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(flushSnapshot, { timeout: 2000 });
      } else {
        flushSnapshot();
      }
    }, 1200);

    return () => {
      window.clearTimeout(timeoutId);
      if (idleId && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [state.conversations]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const flushConversations = () => {
      persistConversationsSnapshot(window.localStorage, CONVERSATIONS_STORAGE_KEY, conversationsRef.current);
    };

    window.addEventListener('pagehide', flushConversations);
    window.addEventListener('beforeunload', flushConversations);

    return () => {
      window.removeEventListener('pagehide', flushConversations);
      window.removeEventListener('beforeunload', flushConversations);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const timer = window.setTimeout(() => {
      saveToStorage('debate_metrics', state.metrics);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [state.metrics]);

  const setAbortController = useCallback((conversationId, controller) => {
    if (!conversationId || !controller) return;
    const existing = abortControllersRef.current.get(conversationId);
    if (existing && existing !== controller && !existing.signal?.aborted) {
      existing.abort();
    }
    abortControllersRef.current.set(conversationId, controller);
  }, []);

  const abortConversationRun = useCallback((conversationId) => {
    if (!conversationId) return;
    const controller = abortControllersRef.current.get(conversationId);
    if (!controller) return;
    if (!controller.signal?.aborted) {
      controller.abort();
    }
    abortControllersRef.current.delete(conversationId);
  }, []);

  const syncCacheStats = useCallback((partial = {}) => {
    const next = {
      ...cacheStatsRef.current,
      ...partial,
    };
    cacheStatsRef.current = next;
    dispatch({ type: 'SET_CACHE_STATS', payload: next });
  }, [dispatch]);

  const updateMetrics = useCallback((updater) => {
    const current = normalizeMetrics(metricsRef.current);
    const nextDraft = updater({
      ...current,
      firstAnswerTimes: [...current.firstAnswerTimes],
      failureByProvider: { ...current.failureByProvider },
    });
    const next = normalizeMetrics(nextDraft || current);
    next.lastUpdated = Date.now();
    metricsRef.current = next;
    dispatch({ type: 'SET_METRICS', payload: next });
  }, [dispatch]);

  const addFailureByProvider = useCallback((providerId) => {
    const provider = providerId || 'unknown';
    updateMetrics((prev) => {
      const next = { ...prev, failureByProvider: { ...prev.failureByProvider } };
      next.failureByProvider[provider] = (next.failureByProvider[provider] || 0) + 1;
      return next;
    });
  }, [updateMetrics]);

  const recordFirstAnswerMetric = useCallback((ms) => {
    if (!Number.isFinite(ms) || ms < 0) return;
    updateMetrics((prev) => ({
      ...prev,
      firstAnswerTimes: trimSample([...prev.firstAnswerTimes, Math.round(ms)]),
    }));
  }, [updateMetrics]);

  useEffect(() => {
    let cancelled = false;

    dispatch({ type: 'SET_MODEL_CATALOG_STATUS', payload: { status: 'loading', error: null } });

    fetchModels(state.apiKey)
      .then((models) => {
        if (cancelled) return;
        const catalog = {};
        for (const model of models) {
          const id = model.id || model.name || model.model;
          if (id) catalog[id] = model;
        }
        dispatch({ type: 'SET_MODEL_CATALOG', payload: catalog });
        dispatch({ type: 'SET_MODEL_CATALOG_STATUS', payload: { status: 'ready', error: null } });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({ type: 'SET_MODEL_CATALOG_STATUS', payload: { status: 'error', error: err.message || 'Failed to load models' } });
      });

    return () => {
      cancelled = true;
    };
  }, [state.apiKey]);

  useEffect(() => {
    if (state.modelCatalogStatus !== 'ready') return;
    const availableIds = Object.keys(state.modelCatalog || {});
    if (availableIds.length === 0) return;
    const availableSet = new Set(availableIds);

    const filterAvailable = (models) => models.filter((model) => availableSet.has(model));
    const unique = (models) => Array.from(new Set(models));
    const fallbackDebate = unique(filterAvailable(DEFAULT_DEBATE_MODELS));

    let nextSelected = filterAvailable(state.selectedModels);
    if (nextSelected.length === 0) {
      nextSelected = fallbackDebate.length > 0 ? fallbackDebate : availableIds.slice(0, 3);
    }
    if (nextSelected.join('|') !== state.selectedModels.join('|')) {
      dispatch({ type: 'SET_MODELS', payload: nextSelected });
    }

    const pickSingle = (current, fallbackList) => {
      if (availableSet.has(current)) return current;
      const fallback = fallbackList.find((model) => availableSet.has(model));
      if (fallback) return fallback;
      return availableIds[0] || current;
    };

    const nextSynth = pickSingle(state.synthesizerModel, [DEFAULT_SYNTHESIZER_MODEL, ...nextSelected]);
    if (nextSynth !== state.synthesizerModel) {
      dispatch({ type: 'SET_SYNTHESIZER', payload: nextSynth });
    }

    const nextConv = pickSingle(state.convergenceModel, [DEFAULT_CONVERGENCE_MODEL, ...nextSelected]);
    if (nextConv !== state.convergenceModel) {
      dispatch({ type: 'SET_CONVERGENCE_MODEL', payload: nextConv });
    }

    const nextSearch = pickSingle(state.webSearchModel, [DEFAULT_WEB_SEARCH_MODEL, ...nextSelected]);
    if (nextSearch !== state.webSearchModel) {
      dispatch({ type: 'SET_WEB_SEARCH_MODEL', payload: nextSearch });
    }
  }, [
    state.modelCatalogStatus,
    state.modelCatalog,
    state.selectedModels,
    state.synthesizerModel,
    state.convergenceModel,
    state.webSearchModel,
  ]);

  useEffect(() => {
    let cancelled = false;

    dispatch({ type: 'SET_PROVIDER_STATUS_STATE', payload: { status: 'loading', error: null } });

    fetchCapabilities()
      .then((payload) => {
        if (cancelled) return;
        const capabilityRegistry = payload?.capabilityRegistry || null;
        const providers = Object.fromEntries(
          Object.entries(capabilityRegistry?.providers || {}).map(([providerId, info]) => [
            providerId,
            Boolean(info?.enabled),
          ])
        );
        dispatch({ type: 'SET_PROVIDER_STATUS', payload: providers });
        dispatch({ type: 'SET_CAPABILITY_REGISTRY', payload: capabilityRegistry });
        dispatch({ type: 'SET_PROVIDER_STATUS_STATE', payload: { status: 'ready', error: null } });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({ type: 'SET_CAPABILITY_REGISTRY', payload: null });
        dispatch({ type: 'SET_PROVIDER_STATUS_STATE', payload: { status: 'error', error: err.message || 'Failed to load providers' } });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeConversation = state.conversations.find(
    c => c.id === state.activeConversationId
  );
  const runningConversationIds = useMemo(() => {
    const ids = new Set();
    for (const conversation of state.conversations) {
      if (isConversationActivelyRunning(conversation)) {
        ids.add(conversation.id);
      }
    }
    return ids;
  }, [state.conversations]);
  const activeConversationInProgress = Boolean(
    activeConversation?.id && runningConversationIds.has(activeConversation.id)
  );
  const runConvergenceOnFinalRound = Boolean(state.convergenceOnFinalRound);
  const isConversationInProgress = useCallback(
    (conversationId) => Boolean(conversationId && runningConversationIds.has(conversationId)),
    [runningConversationIds]
  );
  const requestAutoConversationTitle = useCallback(({
    conversationId,
    userPrompt,
    synthesisContent,
    apiKey,
  }) => {
    if (!conversationId || !userPrompt || !synthesisContent || !apiKey) return;

    const requestedAt = Date.now();
    generateTitle({
      userPrompt,
      synthesisContent,
      apiKey,
    }).then((result) => {
      if (!result?.title) return;

      dispatch({
        type: 'SET_CONVERSATION_TITLE',
        payload: {
          conversationId,
          title: result.title,
          source: TITLE_SOURCE_AUTO,
          requestedAt,
        },
      });

      if (result.description) {
        dispatch({
          type: 'SET_CONVERSATION_DESCRIPTION',
          payload: { conversationId, description: result.description },
        });
      }
    }).catch(() => {
      // Auto title generation failure is non-blocking.
    });
  }, [dispatch]);

  const prepareConversationHistory = useCallback(({
    conversationId,
    conversation,
    summaryModel,
    apiKey,
    signal,
  }) => {
    const currentConversation = conversation || state.conversations.find((item) => item.id === conversationId) || null;
    const summarizedTurnCount = currentConversation?.summarizedTurnCount || 0;
    const pendingSummaryUntilTurnCount = currentConversation?.pendingSummaryUntilTurnCount || summarizedTurnCount;
    const hasPendingSummary = pendingSummaryUntilTurnCount > summarizedTurnCount;
    const contextPlan = buildConversationContext({
      conversation: currentConversation,
      runningSummary: currentConversation?.runningSummary || null,
      summarizedTurnCount,
      pendingSummaryUntilTurnCount,
    });

    if (
      !hasPendingSummary
      && summaryModel
      && apiKey
      && contextPlan.needsSummary
      && currentConversation
      && contextPlan.summaryEndTurnIndex > contextPlan.summaryStartTurnIndex
    ) {
      const nextPendingTurnCount = contextPlan.summaryEndTurnIndex;
      dispatch({
        type: 'SET_RUNNING_SUMMARY_PENDING',
        payload: {
          conversationId,
          pendingTurnCount: nextPendingTurnCount,
        },
      });

      const turnsForSummary = currentConversation.turns.slice(
        contextPlan.summaryStartTurnIndex,
        contextPlan.summaryEndTurnIndex,
      );
      const summaryMessages = buildSummaryPrompt({
        existingSummary: currentConversation.runningSummary || null,
        turnsToSummarize: turnsForSummary,
        startTurnNumber: contextPlan.summaryStartTurnIndex + 1,
      });

      chatCompletion({
        model: summaryModel,
        messages: summaryMessages,
        apiKey,
        signal,
      }).then(({ content: summary }) => {
        dispatch({
          type: 'SET_RUNNING_SUMMARY',
          payload: {
            conversationId,
            summary,
            summarizedTurnCount: nextPendingTurnCount,
            expectedCurrentPendingTurnCount: nextPendingTurnCount,
          },
        });
      }).catch(() => {
        dispatch({
          type: 'SET_RUNNING_SUMMARY_PENDING',
          payload: {
            conversationId,
            pendingTurnCount: summarizedTurnCount,
            expectedCurrentPendingTurnCount: nextPendingTurnCount,
          },
        });
      });
    }

    return contextPlan.messages;
  }, [dispatch, state.conversations]);

  useEffect(() => {
    if (abortControllersRef.current.size === 0) return;
    for (const [conversationId, controller] of abortControllersRef.current.entries()) {
      if (!runningConversationIds.has(conversationId) || controller?.signal?.aborted) {
        abortControllersRef.current.delete(conversationId);
      }
    }
  }, [runningConversationIds]);

  const retryPolicy = normalizeRetryPolicy(state.retryPolicy);

  /**
   * Run one round of streaming from all models in parallel.
   * Returns an array of { model, content, index, error? } results.
   */
  const isAbortLikeError = (err) => {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const message = String(err.message || '').toLowerCase();
    return message.includes('aborted') || message.includes('canceled') || message.includes('cancelled');
  };

  const getCircuitState = (providerId) => {
    const provider = providerId || 'unknown';
    if (!providerCircuitRef.current[provider]) {
      providerCircuitRef.current[provider] = {
        failures: 0,
        openedUntil: 0,
        openedAt: 0,
        lastError: '',
      };
    }
    return providerCircuitRef.current[provider];
  };

  const isCircuitOpen = (providerId) => {
    const state = getCircuitState(providerId);
    return Number.isFinite(state.openedUntil) && state.openedUntil > Date.now();
  };

  const markProviderSuccess = (providerId) => {
    const state = getCircuitState(providerId);
    state.failures = 0;
    state.lastError = '';
    if (state.openedUntil && state.openedUntil < Date.now()) {
      state.openedUntil = 0;
      state.openedAt = 0;
    }
  };

  const markProviderFailure = (providerId, err) => {
    const provider = providerId || 'unknown';
    const state = getCircuitState(provider);
    state.failures += 1;
    state.lastError = String(err?.message || err || 'Unknown error');
    if (state.failures >= retryPolicy.circuitFailureThreshold) {
      state.openedAt = Date.now();
      state.openedUntil = Date.now() + retryPolicy.circuitCooldownMs;
      state.failures = 0;
    }
  };

  const waitForRetryDelay = async (ms, signal) => {
    if (ms <= 0) return;
    await new Promise((resolve, reject) => {
      let timeoutId = null;
      const cleanup = () => {
        if (timeoutId != null) clearTimeout(timeoutId);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        const aborted = new Error('Aborted');
        aborted.name = 'AbortError';
        reject(aborted);
      };
      timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      if (signal?.aborted) {
        onAbort();
      } else if (signal?.addEventListener) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  const buildResponseCacheKey = ({ model, messages, nativeWebSearch = false }) => {
    const payload = JSON.stringify({ model, nativeWebSearch: Boolean(nativeWebSearch), messages });
    const hashed = hashCacheKeyPayload(payload);
    return `${String(model || 'model')}::${payload.length}::${hashed}`;
  };

  const getCachedResponse = (cacheKey) => {
    if (!cacheKey) return null;
    const entry = responseCacheRef.current.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      responseCacheRef.current.delete(cacheKey);
      if (state.cachePersistenceEnabled) {
        persistResponseCache(responseCacheRef.current);
      }
      syncCacheStats({ cacheEntryCount: responseCacheRef.current.size });
      return null;
    }
    syncCacheStats({ cacheHitCount: cacheStatsRef.current.cacheHitCount + 1 });
    return entry.value;
  };

  const setCachedResponse = (cacheKey, value, ttlMs = RESPONSE_CACHE_TTL_MS) => {
    if (!cacheKey || !value?.content) return;
    const normalizedTtlMs = Number.isFinite(Number(ttlMs))
      ? Math.max(0, Math.floor(Number(ttlMs)))
      : RESPONSE_CACHE_TTL_MS;
    if (normalizedTtlMs <= 0) return;
    if (responseCacheRef.current.size >= RESPONSE_CACHE_MAX_ENTRIES) {
      const oldestKey = responseCacheRef.current.keys().next().value;
      if (oldestKey) responseCacheRef.current.delete(oldestKey);
    }
    responseCacheRef.current.set(cacheKey, {
      expiresAt: Date.now() + normalizedTtlMs,
      value,
    });
    if (state.cachePersistenceEnabled) {
      persistResponseCache(responseCacheRef.current);
    }
    syncCacheStats({ cacheEntryCount: responseCacheRef.current.size });
  };

  const clearExpiredCacheEntries = () => {
    let changed = false;
    const now = Date.now();
    for (const [key, entry] of responseCacheRef.current.entries()) {
      if (!entry || entry.expiresAt <= now) {
        responseCacheRef.current.delete(key);
        changed = true;
      }
    }
    if (changed) {
      if (state.cachePersistenceEnabled) {
        persistResponseCache(responseCacheRef.current);
      }
      syncCacheStats({ cacheEntryCount: responseCacheRef.current.size });
    }
  };

  useEffect(() => {
    clearExpiredCacheEntries();
    syncCacheStats({ cacheEntryCount: responseCacheRef.current.size });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.cachePersistenceEnabled) {
      persistResponseCache(responseCacheRef.current);
    } else {
      localStorage.removeItem(RESPONSE_CACHE_STORAGE_KEY);
      clearLegacyResponseCacheStorage();
    }
  }, [state.cachePersistenceEnabled]);

  const clearResponseCache = useCallback(() => {
    responseCacheRef.current.clear();
    localStorage.removeItem(RESPONSE_CACHE_STORAGE_KEY);
    clearLegacyResponseCacheStorage();
    syncCacheStats({ cacheHitCount: 0, cacheEntryCount: 0 });
    dispatch({ type: 'CLEAR_RESPONSE_CACHE' });
  }, [dispatch, syncCacheStats]);

  const resetDiagnostics = useCallback(() => {
    const next = createDefaultMetrics();
    metricsRef.current = next;
    dispatch({ type: 'SET_METRICS', payload: next });
  }, [dispatch]);

  const buildProvisionalSynthesisContent = ({ streams, roundLabel }) => {
    const completed = (streams || []).filter((stream) => stream?.model && stream?.content);
    if (completed.length === 0) return '';
    const snippets = completed.map((stream) => {
      const normalized = String(stream.content || '').replace(/\s+/g, ' ').trim();
      const snippet = normalized.length > 220 ? `${normalized.slice(0, 220).trim()}...` : normalized;
      return `- **${stream.model}**: ${snippet || '(no content yet)'}`;
    });
    return [
      `### Provisional Synthesis (${roundLabel || 'current round'})`,
      '',
      'Draft view built from completed model responses so far. This will update as more responses arrive.',
      '',
      ...snippets,
    ].join('\n');
  };

  const shouldStopEarlyFromConvergence = ({ roundNum, maxRounds, previousStreams, currentStreams, convergenceCheck }) => {
    if (roundNum < 2 || roundNum >= maxRounds) return false;
    if (!convergenceCheck || convergenceCheck.converged) return false;
    const confidence = Number(convergenceCheck.confidence);
    if (!Number.isFinite(confidence) || confidence < 78) return false;
    const previousMap = new Map((previousStreams || []).map((stream) => [stream.model, stream.content || '']));
    if (previousMap.size === 0) return false;
    const comparable = (currentStreams || [])
      .filter((stream) => previousMap.has(stream.model) && stream.content)
      .map((stream) => computeWordSetSimilarity(previousMap.get(stream.model), stream.content));
    if (comparable.length === 0) return false;
    const avgSimilarity = comparable.reduce((sum, value) => sum + value, 0) / comparable.length;
    return avgSimilarity >= 0.9;
  };

  const resolveModelRoute = (model, models) => {
    const requestedProvider = getModelProviderId(model);
    const circuitState = getCircuitState(requestedProvider);
    if (!isCircuitOpen(requestedProvider)) {
      return { requestedModel: model, effectiveModel: model, routed: false, routeInfo: null };
    }
    const fallbackModel = (models || []).find((candidate) => {
      if (!candidate || candidate === model) return false;
      const provider = getModelProviderId(candidate);
      return !isCircuitOpen(provider);
    });
    if (!fallbackModel) {
      return {
        requestedModel: model,
        effectiveModel: model,
        routed: false,
        routeInfo: {
          routed: false,
          provider: requestedProvider,
          reason: `Provider circuit open (${Math.max(0, Math.ceil((circuitState.openedUntil - Date.now()) / 1000))}s remaining); no fallback available.`,
        },
      };
    }
    const fallbackProvider = getModelProviderId(fallbackModel);
    return {
      requestedModel: model,
      effectiveModel: fallbackModel,
      routed: true,
      routeInfo: {
        routed: true,
        provider: requestedProvider,
        fallbackProvider,
        fallbackModel,
        reason: `${requestedProvider} is temporarily unstable; routed to ${fallbackProvider}.`,
      },
    };
  };

  const supportsNativeWebSearchForModel = useCallback((model) => (
    canUseNativeWebSearch({
      model,
      providerStatus: state.providerStatus,
      capabilityRegistry: state.capabilityRegistry,
      modelCatalog: state.modelCatalog,
    })
  ), [state.providerStatus, state.capabilityRegistry, state.modelCatalog]);

  const buildNativeWebSearchStrategy = useCallback(({
    models,
    webSearchEnabled,
    fallbackSearchModel,
    forceLegacy = false,
  }) => {
    const selectedModels = Array.isArray(models) ? models.filter(Boolean) : [];
    if (!webSearchEnabled || selectedModels.length === 0) {
      return {
        nativeWebSearch: false,
        needsLegacyPreflight: false,
        fallbackReason: null,
      };
    }

    if (forceLegacy && fallbackSearchModel) {
      return {
        nativeWebSearch: false,
        needsLegacyPreflight: true,
        fallbackReason: 'Native web search bypassed; using legacy web-search context.',
      };
    }

    const eligibleModels = selectedModels.filter((model) => supportsNativeWebSearchForModel(model));
    if (eligibleModels.length === 0) {
      return {
        nativeWebSearch: false,
        needsLegacyPreflight: Boolean(fallbackSearchModel),
        fallbackReason: fallbackSearchModel
          ? 'Selected models do not support native web search; using legacy web-search context.'
          : null,
      };
    }

    if (eligibleModels.length === selectedModels.length) {
      return {
        nativeWebSearch: true,
        needsLegacyPreflight: false,
        fallbackReason: null,
      };
    }

    if (fallbackSearchModel) {
      return {
        nativeWebSearch: false,
        needsLegacyPreflight: true,
        fallbackReason: 'Some selected models do not support native web search; using legacy web-search context.',
      };
    }

    const eligibleSet = new Set(eligibleModels);
    return {
      nativeWebSearch: (model) => eligibleSet.has(model),
      needsLegacyPreflight: false,
      fallbackReason: null,
    };
  }, [supportsNativeWebSearchForModel]);

  const enforceStrictSearchEvidence = ({
    results,
    convId,
    turnId,
    runId,
    roundIndex,
    strictMode = false,
  }) => {
    if (!strictMode || !Array.isArray(results)) return results;

    const turnScope = { conversationId: convId, turnId, runId };
    return results.map((result) => {
      if (!result || result.error || !result.content) return result;
      if (result.searchEvidence?.verified) return result;

      const message = result.searchEvidence?.primaryIssue
        ? `Strict web-search mode blocked this response: ${result.searchEvidence.primaryIssue}`
        : 'Strict web-search mode blocked this response: unable to verify web evidence.';

      const blockedEvidence = {
        ...(result.searchEvidence || {}),
        verified: false,
        strictBlocked: true,
        strictError: message,
      };

      dispatchTurnScoped(turnScope, 'UPDATE_ROUND_STREAM', {
        roundIndex,
        streamIndex: result.index,
        content: '',
        status: 'error',
        error: message,
        errorKind: 'strict_blocked',
        outcome: null,
        retryProgress: null,
        searchEvidence: blockedEvidence,
      });

      return {
        ...result,
        content: '',
        error: message,
        errorKind: 'strict_blocked',
        searchEvidence: blockedEvidence,
      };
    });
  };

  const isNativeSearchRelatedError = (message) => {
    const lowered = String(message || '').toLowerCase();
    if (!lowered) return false;
    return (
      lowered.includes('web_search') ||
      lowered.includes('web search') ||
      lowered.includes('google_search') ||
      lowered.includes('plugin') ||
      lowered.includes('tools') ||
      lowered.includes('tool_choice') ||
      lowered.includes('unsupported') ||
      lowered.includes('invalid_request') ||
      lowered.includes('unknown field')
    );
  };

  const shouldFallbackToLegacyWebSearch = (results) => {
    if (!Array.isArray(results) || results.length === 0) return false;
    const errors = results.filter(r => r?.error).map(r => r.error);
    if (errors.length === 0) return false;
    if (errors.length === results.length) return true;
    return errors.some(isNativeSearchRelatedError);
  };

  const MAX_LATER_ROUND_SEARCH_REFRESHES = 1;
  const FACTUAL_DISAGREEMENT_HINT_REGEX = /\b(\d{4}|\d+(?:\.\d+)?%|\$|usd|eur|gbp|million|billion|trillion|percent|date|year|month|day|published|updated|timestamp|population|revenue|gdp|inflation|rate|price|cases|deaths|law|statute|court|study|trial|report|source|citation)\b/i;

  const isEvidenceQualityLow = (results) => {
    if (!Array.isArray(results) || results.length === 0) return false;
    const completed = results.filter((result) => result && !result.error && result.content);
    if (completed.length === 0) return false;

    const evidenceResults = completed.filter((result) => result.searchEvidence);
    if (evidenceResults.length === 0) return false;

    const lowEvidenceCount = evidenceResults.filter((result) => !result.searchEvidence?.verified).length;
    return lowEvidenceCount >= Math.ceil(evidenceResults.length / 2);
  };

  const hasFactualDisagreement = (convergenceCheck) => {
    if (!convergenceCheck || convergenceCheck.converged) return false;

    const disagreements = Array.isArray(convergenceCheck.disagreements)
      ? convergenceCheck.disagreements
      : [];

    const parts = [];
    if (
      typeof convergenceCheck.reason === 'string' &&
      !convergenceCheck.reason.toLowerCase().startsWith('convergence check failed')
    ) {
      parts.push(convergenceCheck.reason);
    }
    for (const disagreement of disagreements) {
      if (!disagreement || typeof disagreement !== 'object') continue;
      if (typeof disagreement.point === 'string') parts.push(disagreement.point);
      const modelPositions = disagreement.models && typeof disagreement.models === 'object'
        ? Object.values(disagreement.models)
        : [];
      for (const position of modelPositions) {
        if (typeof position === 'string') parts.push(position);
      }
    }

    if (parts.length === 0) return false;
    const combined = parts.join(' ').toLowerCase();
    return /\b\d+(?:\.\d+)?\b/.test(combined) || FACTUAL_DISAGREEMENT_HINT_REGEX.test(combined);
  };

  const getLaterRoundSearchRefreshDecision = ({
    roundNum,
    maxRounds,
    webSearchEnabled,
    canUseLegacySearchFallback,
    refreshesUsed,
    results,
    convergenceCheck,
  }) => {
    if (!webSearchEnabled || !canUseLegacySearchFallback) {
      return { shouldRefresh: false, evidenceQualityLow: false, factualDisagreement: false };
    }
    if (roundNum < 2 || roundNum >= maxRounds) {
      return { shouldRefresh: false, evidenceQualityLow: false, factualDisagreement: false };
    }
    if (refreshesUsed >= MAX_LATER_ROUND_SEARCH_REFRESHES) {
      return { shouldRefresh: false, evidenceQualityLow: false, factualDisagreement: false };
    }

    const evidenceQualityLow = isEvidenceQualityLow(results);
    const factualDisagreement = hasFactualDisagreement(convergenceCheck);
    return {
      shouldRefresh: evidenceQualityLow || factualDisagreement,
      evidenceQualityLow,
      factualDisagreement,
    };
  };

  const didUseLaterRoundSearchRefresh = (rounds) => {
    if (!Array.isArray(rounds) || rounds.length === 0) return false;
    return rounds.some((round) => (
      round?.roundNumber > 1 &&
      Array.isArray(round.streams) &&
      round.streams.some((stream) => stream?.searchEvidence?.mode === 'refresh_context')
    ));
  };

  const formatWebSearchPrompt = (prompt, context, model, options = {}) => {
    const { requireEvidence = false, strictMode = false } = options;
    const evidenceInstruction = requireEvidence
      ? `\n\nWhen search is enabled, include full source URLs and publication dates/timestamps for key claims.${strictMode ? ' If you cannot verify current information, explicitly say so instead of guessing.' : ''}`
      : '';
    if (context) {
      return `${prompt}${evidenceInstruction}\n\n---\n**Web Search Context (from ${model}):**\n${context}`;
    }
    return `${prompt}${evidenceInstruction}`;
  };

  const buildInitialMessagesForModels = ({
    models,
    conversationHistory,
    userMessageContent,
    attachments,
    videoUrls = [],
    systemMessages = [],
  }) => buildAttachmentMessagesForModels({
    models,
    systemMessages,
    conversationHistory,
    userMessageContent,
    attachments,
    modelCatalog: state.modelCatalog,
    capabilityRegistry: state.capabilityRegistry,
    videoUrls,
  });

  const buildAttachmentRoutingForTurn = (attachments, models) => buildAttachmentRoutingOverview({
    attachments,
    models,
    modelCatalog: state.modelCatalog,
    capabilityRegistry: state.capabilityRegistry,
  });

  const runLegacyWebSearch = async ({
    convId,
    turnId,
    runId,
    userPrompt,
    attachments,
    videoUrls = [],
    webSearchModel,
    apiKey,
    signal,
  }) => {
    const turnScope = { conversationId: convId, turnId, runId };
    dispatchTurnScoped(turnScope, 'SET_WEB_SEARCH_RESULT', {
      result: { status: 'searching', content: '', model: webSearchModel, error: null, usage: null, durationMs: null },
    });

    try {
      const searchPrompt = buildAttachmentTextContent(userPrompt, attachments, { videoUrls });
      const { content: searchContent, usage: searchUsage, durationMs: searchDurationMs } = await chatCompletion({
        model: webSearchModel,
        messages: [
          {
            role: 'system',
            content: 'Search the web for current, accurate information relevant to the user query. Include source URLs and publication dates/timestamps for key facts in your summary.',
          },
          { role: 'user', content: searchPrompt },
        ],
        apiKey,
        signal,
      });

      dispatchTurnScoped(turnScope, 'SET_WEB_SEARCH_RESULT', {
        result: { status: 'complete', content: searchContent, model: webSearchModel, error: null, usage: searchUsage, durationMs: searchDurationMs },
      });
      return searchContent;
    } catch (err) {
      if (signal?.aborted) throw err;
      dispatchTurnScoped(turnScope, 'SET_WEB_SEARCH_RESULT', {
        result: { status: 'error', content: '', model: webSearchModel, error: err.message, usage: null, durationMs: null },
      });
      return '';
    }
  };

  const runStreamWithFallback = async ({
    model,
    messages,
    apiKey,
    signal,
    onChunk,
    onReasoning,
    onRetryProgress,
    nativeWebSearch = false,
    forceRefresh = false,
    cacheable = true,
    cachePolicy = null,
  }) => {
    clearExpiredCacheEntries();
    const providerId = getModelProviderId(model);
    const cacheAllowed = cacheable && (cachePolicy?.cacheable ?? true);
    const cacheTtlMs = Number.isFinite(Number(cachePolicy?.ttlMs))
      ? Math.max(0, Math.floor(Number(cachePolicy.ttlMs)))
      : RESPONSE_CACHE_TTL_MS;
    const cacheKey = cacheAllowed ? buildResponseCacheKey({ model, messages, nativeWebSearch }) : '';
    if (cacheAllowed && !forceRefresh) {
      const cached = getCachedResponse(cacheKey);
      if (cached) {
        if (cached.content) onChunk?.(cached.content, cached.content);
        if (cached.reasoning) onReasoning?.(cached.reasoning);
        return { ...cached, fromCache: true, retryCount: 0 };
      }
    }

    let lastError = null;
    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
      let result = null;
      try {
        updateMetrics((prev) => ({ ...prev, callCount: prev.callCount + 1 }));
        result = await streamChat({ model, messages, apiKey, signal, onChunk, onReasoning, nativeWebSearch });
      } catch (streamErr) {
        lastError = streamErr;
        if (signal?.aborted) throw streamErr;

        if (isAbortLikeError(streamErr)) {
          try {
            updateMetrics((prev) => ({ ...prev, callCount: prev.callCount + 1 }));
            const fallbackResult = await chatCompletion({ model, messages, apiKey, signal, nativeWebSearch });
            if (fallbackResult?.content) onChunk?.(fallbackResult.content, fallbackResult.content);
            if (fallbackResult?.reasoning) onReasoning?.(fallbackResult.reasoning);
            result = fallbackResult;
          } catch (completionErr) {
            lastError = completionErr;
          }
        }
      }

      if (result) {
        onRetryProgress?.(null);
        markProviderSuccess(providerId);
        const usedTokens = Number(result?.usage?.totalTokens);
        updateMetrics((prev) => ({
          ...prev,
          successCount: prev.successCount + 1,
          successfulTokenTotal: prev.successfulTokenTotal + (Number.isFinite(usedTokens) ? Math.max(0, Math.floor(usedTokens)) : 0),
          retryRecovered: prev.retryRecovered + (attempt > 1 ? 1 : 0),
        }));
        const finalized = { ...result, fromCache: false, retryCount: attempt - 1 };
        if (cacheAllowed && finalized.content) {
          setCachedResponse(cacheKey, finalized, cacheTtlMs);
        }
        return finalized;
      }

      const err = lastError || new Error('Request failed');
      markProviderFailure(providerId, err);
      const shouldRetry = attempt < retryPolicy.maxAttempts && isTransientRetryableError(err, isAbortLikeError);
      if (!shouldRetry) {
        onRetryProgress?.(null);
        addFailureByProvider(providerId);
        updateMetrics((prev) => ({ ...prev, failureCount: prev.failureCount + 1 }));
        throw err;
      }
      updateMetrics((prev) => ({ ...prev, retryAttempts: prev.retryAttempts + 1 }));
      const delayMs = getRetryDelayMs(attempt, retryPolicy);
      onRetryProgress?.({
        active: true,
        attempt: attempt + 1,
        maxAttempts: retryPolicy.maxAttempts,
        delayMs,
        error: err.message || 'Request failed',
      });
      await waitForRetryDelay(delayMs, signal);
    }

    const terminalError = lastError || new Error('Request failed');
    onRetryProgress?.(null);
    addFailureByProvider(providerId);
    updateMetrics((prev) => ({ ...prev, failureCount: prev.failureCount + 1 }));
    throw terminalError;
  };

  const runRound = async ({
    models,
    messages,
    messagesPerModel,
    convId,
    turnId,
    runId,
    roundIndex,
    apiKey,
    signal,
    nativeWebSearch = false,
    searchVerification = null,
    forceRefresh = false,
    onModelSuccess = null,
  }) => {
    const turnScope = { conversationId: convId, turnId, runId };
    const dispatchTurnAction = (type, payload = {}) => dispatchTurnScoped(turnScope, type, payload);
    const streamResults = await Promise.allSettled(
      models.map(async (model, index) => {
        const route = resolveModelRoute(model, models);
        const effectiveModel = route.effectiveModel || model;
        const routeInfo = route.routeInfo || null;
        const useNativeSearchForModel = typeof nativeWebSearch === 'function'
          ? Boolean(nativeWebSearch(model))
          : Boolean(nativeWebSearch);
        const searchMode = typeof searchVerification?.mode === 'function'
          ? searchVerification.mode({ model, index, useNativeSearchForModel })
          : (
            searchVerification?.mode
            || (useNativeSearchForModel ? 'native' : 'legacy_context')
          );
        const cachePolicy = searchVerification?.enabled
          ? getSearchResponseCachePolicy({
            prompt: searchVerification.prompt,
            searchEnabled: true,
            defaultTtlMs: RESPONSE_CACHE_TTL_MS,
          })
          : null;

        dispatchTurnAction('UPDATE_ROUND_STREAM', {
          roundIndex,
          streamIndex: index,
          model,
          content: '',
          status: 'streaming',
          error: null,
          errorKind: null,
          outcome: null,
          completedAt: null,
          retryProgress: null,
          cacheHit: false,
          searchEvidence: searchVerification?.enabled ? null : undefined,
          routeInfo,
        });

        const modelMessages = messagesPerModel ? messagesPerModel[index] : messages;

        try {
          const { content, reasoning, usage, durationMs, fromCache, searchMetadata } = await runStreamWithFallback({
            model: effectiveModel,
            messages: modelMessages,
            apiKey,
            signal,
            nativeWebSearch: useNativeSearchForModel,
            forceRefresh,
            cachePolicy,
            onRetryProgress: (retryProgress) => {
              dispatchTurnAction('UPDATE_ROUND_STREAM', {
                roundIndex,
                streamIndex: index,
                status: 'streaming',
                error: null,
                errorKind: null,
                retryProgress,
                routeInfo,
              });
            },
            onChunk: (_delta, accumulated) => {
              dispatchTurnAction('UPDATE_ROUND_STREAM', {
                roundIndex,
                streamIndex: index,
                content: accumulated,
                status: 'streaming',
                error: null,
                errorKind: null,
                routeInfo,
              });
            },
            onReasoning: (accumulatedReasoning) => {
              dispatchTurnAction('UPDATE_ROUND_STREAM', {
                roundIndex,
                streamIndex: index,
                status: 'streaming',
                error: null,
                errorKind: null,
                reasoning: accumulatedReasoning,
                routeInfo,
              });
            },
          });

          const searchEvidence = searchVerification?.enabled
            ? buildSearchEvidence({
              prompt: searchVerification.prompt,
              content,
              searchMetadata,
              strictMode: Boolean(searchVerification.strictMode),
              mode: searchMode,
              fallbackApplied: Boolean(searchVerification.fallbackApplied),
              fallbackReason: searchVerification.fallbackReason || null,
            })
            : undefined;

          dispatchTurnAction('UPDATE_ROUND_STREAM', {
            roundIndex,
            streamIndex: index,
            model,
            content,
            status: 'complete',
            error: null,
            errorKind: null,
            outcome: 'success',
            usage,
            durationMs,
            completedAt: Date.now(),
            reasoning: reasoning || null,
            retryProgress: null,
            cacheHit: Boolean(fromCache),
            searchEvidence,
            routeInfo,
          });

          onModelSuccess?.({
            model,
            effectiveModel,
            content,
            index,
            roundIndex,
            fromCache: Boolean(fromCache),
            routeInfo,
          });

          return {
            model,
            content,
            index,
            searchEvidence,
            searchMetadata,
            routeInfo,
            effectiveModel,
            fromCache: Boolean(fromCache),
          };
        } catch (err) {
          if (err.name === 'AbortError') {
            dispatchTurnAction('UPDATE_ROUND_STREAM', {
              roundIndex,
              streamIndex: index,
              model,
              content: '',
              status: 'error',
              error: 'Cancelled',
              errorKind: 'cancelled',
              outcome: null,
              retryProgress: null,
              searchEvidence: searchVerification?.enabled ? null : undefined,
              routeInfo,
            });
            return { model, content: '', index, error: 'Cancelled', errorKind: 'cancelled' };
          }
          const errorMsg = err.message || 'An error occurred';
          const diagnostic = routeInfo?.reason && !routeInfo?.routed
            ? `${errorMsg} (${routeInfo.reason})`
            : errorMsg;
          dispatchTurnAction('UPDATE_ROUND_STREAM', {
            roundIndex,
            streamIndex: index,
            model,
            content: '',
            status: 'error',
            error: diagnostic,
            errorKind: 'failed',
            outcome: null,
            retryProgress: null,
            searchEvidence: searchVerification?.enabled ? null : undefined,
            routeInfo,
          });
          return { model, content: '', index, error: diagnostic, errorKind: 'failed', routeInfo, effectiveModel };
        }
      })
    );

    return streamResults.map(r =>
      r.status === 'fulfilled' ? r.value : { model: null, content: '', error: 'Aborted' }
    );
  };

  const startDebate = useCallback(async (userPrompt, {
    webSearch = false,
    attachments,
    focusedOverride,
    forceRefresh = false,
    forceLegacyWebSearch = false,
    modelOverrides,
    routeInfo = null,
  } = {}) => {
    const models = Array.isArray(modelOverrides) && modelOverrides.length > 0
      ? modelOverrides
      : state.selectedModels;
    const synthModel = state.synthesizerModel;
    const convergenceModel = state.convergenceModel;
    const maxRounds = state.maxDebateRounds;
    const webSearchModel = state.webSearchModel;
    const strictWebSearch = state.strictWebSearch;
    const apiKey = state.apiKey;
    const focused = typeof focusedOverride === 'boolean' ? focusedOverride : state.focusedMode;

    // Create new conversation if none active
    let convId = state.activeConversationId;
    if (!convId) {
      convId = Date.now().toString();
      const title = createSeedTitle(userPrompt);
      dispatch({ type: 'NEW_CONVERSATION', payload: { id: convId, title } });
    }
    const existingConversation = state.conversations.find(c => c.id === convId);
    const isFirstTurn = !existingConversation || existingConversation.turns.length === 0;

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });

    // Build new turn with rounds structure
    const turnId = Date.now().toString();
    const runId = createRunId();
    const turn = {
      id: turnId,
      activeRunId: runId,
      userPrompt,
      timestamp: Date.now(),
      attachments: attachments || null,
      attachmentRouting: buildAttachmentRoutingForTurn(attachments, models),
      modelOverrides: Array.isArray(modelOverrides) ? modelOverrides : null,
      routeInfo,
      mode: 'debate',
      focusedMode: focused,
      webSearchEnabled: Boolean(webSearch),
      rounds: [],
      synthesis: {
        model: synthModel,
        content: '',
        status: 'pending',
        error: null,
      },
      debateMetadata: {
        totalRounds: 0,
        converged: false,
        terminationReason: null,
      },
    };

    dispatch({ type: 'ADD_TURN', payload: { conversationId: convId, turn } });
    const turnScope = { conversationId: convId, turnId, runId };
    const dispatchTurnAction = (type, payload = {}) => dispatchTurnScoped(turnScope, type, payload);

    const abortController = new AbortController();
    setAbortController(convId, abortController);

    // ===== WEB SEARCH (optional) =====
    let webSearchContext = '';
    const nativeWebSearchEnabled = Boolean(webSearch);
    const canUseLegacySearchFallback = Boolean(webSearchModel);
    const nativeSearchStrategy = buildNativeWebSearchStrategy({
      models,
      webSearchEnabled: nativeWebSearchEnabled,
      fallbackSearchModel: webSearchModel,
      forceLegacy: forceLegacyWebSearch,
    });

    const currentConv = state.conversations.find(c => c.id === convId);
    const contextMessages = prepareConversationHistory({
      conversationId: convId,
      conversation: currentConv,
      summaryModel: state.synthesizerModel,
      apiKey,
      signal: abortController.signal,
    });

    if (nativeSearchStrategy.needsLegacyPreflight) {
      webSearchContext = await runLegacyWebSearch({
        convId,
        turnId,
        runId,
        userPrompt,
        attachments,
        videoUrls: routeInfo?.youtubeUrls || [],
        webSearchModel,
        apiKey,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }
    }

    // If web search returned results, prepend them as context
    const userMessageContent = formatWebSearchPrompt(userPrompt, webSearchContext, webSearchModel, {
      requireEvidence: nativeWebSearchEnabled,
      strictMode: strictWebSearch,
    });

    // conversationHistory for rebuttal/synthesis builders (just the context messages)
    const conversationHistory = contextMessages;

    const initialMessagesPerModel = buildInitialMessagesForModels({
      models,
      conversationHistory,
      userMessageContent,
      attachments,
      videoUrls: routeInfo?.youtubeUrls || [],
    });

    let lastCompletedStreams = null;
    let converged = false;
    let terminationReason = null;
    let totalRounds = 0;
    let laterRoundSearchRefreshesUsed = 0;
    let hasLaterRoundSearchRefresh = false;
    const synthesisRounds = [];
    const debateStartedAt = Date.now();
    let firstAnswerRecorded = false;

    // ===== MULTI-ROUND DEBATE LOOP =====
    for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
      if (abortController.signal.aborted) break;

      const roundLabel = getRoundLabel(roundNum);
      const round = createRound({ roundNumber: roundNum, label: roundLabel, models });
      const roundIndex = roundNum - 1;
      let roundConvergence = null;
      const provisionalRoundStreams = [];

      const handleRoundModelSuccess = ({ model: successModel, content: successContent }) => {
        if (!successModel || !successContent) return;
        const updated = { model: successModel, content: successContent, status: 'complete' };
        const existingIndex = provisionalRoundStreams.findIndex((stream) => stream.model === successModel);
        if (existingIndex >= 0) {
          provisionalRoundStreams[existingIndex] = updated;
        } else {
          provisionalRoundStreams.push(updated);
        }
        if (!firstAnswerRecorded) {
          firstAnswerRecorded = true;
          recordFirstAnswerMetric(Date.now() - debateStartedAt);
        }
        const provisionalContent = buildProvisionalSynthesisContent({
          streams: provisionalRoundStreams,
          roundLabel,
        });
        if (!provisionalContent) return;
        dispatchTurnAction('UPDATE_SYNTHESIS', {
          model: synthModel,
          content: provisionalContent,
          status: 'streaming',
          error: null,
          retryProgress: null,
        });
      };

      dispatchTurnAction('ADD_ROUND', { round });
      dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'streaming' });

      let roundMessages;
      let messagesPerModel = null;

      if (roundNum === 1) {
        messagesPerModel = initialMessagesPerModel;
      } else {
        // Rebuttal rounds: each model gets messages with previous round's responses
        messagesPerModel = models.map(() =>
          buildRebuttalMessages({
            userPrompt,
            previousRoundStreams: lastCompletedStreams,
            roundNumber: roundNum,
            conversationHistory,
            focused,
            webSearchContext,
            webSearchModel,
          })
        );
      }

      const roundSearchVerification = nativeWebSearchEnabled
        ? {
          enabled: true,
          prompt: userPrompt,
          strictMode: roundNum === 1 ? strictWebSearch : false,
          mode: roundNum === 1
            ? ({ useNativeSearchForModel }) => {
              if (webSearchContext) return 'legacy_context';
              return useNativeSearchForModel ? 'native' : 'native_skipped';
            }
            : (hasLaterRoundSearchRefresh ? 'refresh_context' : (webSearchContext ? 'legacy_context' : 'debate_rebuttal')),
          fallbackApplied: roundNum === 1 && Boolean(webSearchContext && nativeSearchStrategy.fallbackReason),
          fallbackReason: roundNum === 1 && webSearchContext
            ? nativeSearchStrategy.fallbackReason
            : null,
        }
        : null;

      let results = await runRound({
        models,
        messages: roundMessages,
        messagesPerModel,
        convId,
        turnId,
        runId,
        roundIndex,
        apiKey,
        signal: abortController.signal,
        nativeWebSearch: roundNum === 1 && nativeWebSearchEnabled && !webSearchContext
          ? nativeSearchStrategy.nativeWebSearch
          : false,
        searchVerification: roundSearchVerification,
        forceRefresh,
        onModelSuccess: handleRoundModelSuccess,
      });

      const shouldConsiderSearchFallback =
        roundNum === 1 &&
        nativeWebSearchEnabled &&
        !webSearchContext &&
        canUseLegacySearchFallback &&
        Boolean(nativeSearchStrategy.nativeWebSearch);
      const fallbackForNativeErrors = shouldConsiderSearchFallback
        ? shouldFallbackToLegacyWebSearch(results)
        : false;
      const fallbackForMissingEvidence = shouldConsiderSearchFallback
        ? shouldFallbackForMissingSearchEvidence(results)
        : false;

      if (shouldConsiderSearchFallback && (fallbackForNativeErrors || fallbackForMissingEvidence)) {
        const fallbackReason = fallbackForNativeErrors
          ? 'Native web-search/tool call failed.'
          : 'Native response lacked verifiable source evidence.';
        webSearchContext = await runLegacyWebSearch({
          convId,
          turnId,
          runId,
          userPrompt,
          attachments,
          videoUrls: routeInfo?.youtubeUrls || [],
          webSearchModel,
          apiKey,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) {
          terminationReason = 'cancelled';
          break;
        }
        if (webSearchContext) {
          provisionalRoundStreams.length = 0;
          const fallbackUserMessageContent = formatWebSearchPrompt(userPrompt, webSearchContext, webSearchModel, {
            requireEvidence: nativeWebSearchEnabled,
            strictMode: strictWebSearch,
          });
          roundMessages = null;
          messagesPerModel = buildInitialMessagesForModels({
            models,
            conversationHistory,
            userMessageContent: fallbackUserMessageContent,
            attachments,
            videoUrls: routeInfo?.youtubeUrls || [],
          });
          results = await runRound({
            models,
            messages: roundMessages,
            messagesPerModel,
            convId,
            turnId,
            runId,
            roundIndex,
            apiKey,
            signal: abortController.signal,
            nativeWebSearch: false,
            searchVerification: {
              enabled: true,
              prompt: userPrompt,
              strictMode: strictWebSearch,
              mode: 'legacy_context',
              fallbackApplied: true,
              fallbackReason,
            },
            forceRefresh,
            onModelSuccess: handleRoundModelSuccess,
          });
        }
      }

      if (roundNum === 1 && nativeWebSearchEnabled && strictWebSearch) {
        results = enforceStrictSearchEvidence({
          results,
          convId,
          turnId,
          runId,
          roundIndex,
          strictMode: true,
        });
      }

      if (abortController.signal.aborted) {
        terminationReason = 'cancelled';
        break;
      }

      // Collect completed streams for this round
      const completedStreams = results.filter(r => r.content && !r.error);

      // If ALL models failed, stop the debate
      if (completedStreams.length === 0) {
        dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'error' });
        terminationReason = 'all_models_failed';
        totalRounds = roundNum;
        break;
      }

      // Carry forward last successful response for failed models
      if (lastCompletedStreams && completedStreams.length < models.length) {
        for (const result of results) {
          if (result.error && !result.content) {
            const prev = lastCompletedStreams.find(s => s.model === result.model);
            if (prev) {
              result.content = prev.content;
              // Update the stream in state to show carried-forward content
              dispatchTurnAction('UPDATE_ROUND_STREAM', {
                roundIndex,
                streamIndex: result.index,
                content: prev.content,
                status: 'complete',
                error: 'Failed this round - showing previous response',
                errorKind: result.errorKind || 'failed',
                outcome: 'using_previous_response',
                retryProgress: null,
              });
            }
          }
        }
      }

      const previousRoundStreams = lastCompletedStreams
        ? lastCompletedStreams.map((stream) => ({ ...stream }))
        : null;

      lastCompletedStreams = results
        .filter(r => r.content)
        .map(r => ({ model: r.model, content: r.content, status: 'complete' }));

      dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'complete' });

      totalRounds = roundNum;

      // === CONVERGENCE CHECK (skip round 1; final round optional) ===
      if (shouldRunConvergenceCheck(roundNum, maxRounds, runConvergenceOnFinalRound)) {
        if (abortController.signal.aborted) break;

        dispatchTurnAction('SET_CONVERGENCE', {
          roundIndex,
          convergenceCheck: { converged: null, reason: 'Checking...' },
        });

        try {
          const convergenceMessages = buildConvergenceMessages({
            userPrompt,
            latestRoundStreams: lastCompletedStreams,
            roundNumber: roundNum,
          });

          const { content: convergenceResponse, usage: convergenceUsage } = await chatCompletion({
            model: convergenceModel,
            messages: convergenceMessages,
            apiKey,
            signal: abortController.signal,
          });

          const parsed = parseConvergenceResponse(convergenceResponse);
          parsed.rawResponse = convergenceResponse;
          parsed.usage = convergenceUsage || null;
          roundConvergence = parsed;

          dispatchTurnAction('SET_CONVERGENCE', {
            roundIndex,
            convergenceCheck: parsed,
          });

          if (parsed.converged) {
            converged = true;
            terminationReason = 'converged';
          }
        } catch (err) {
          if (abortController.signal.aborted) break;
          // Convergence check failed — continue debating
          roundConvergence = { converged: false, reason: 'Convergence check failed: ' + err.message };
          dispatchTurnAction('SET_CONVERGENCE', {
            roundIndex,
            convergenceCheck: roundConvergence,
          });
        }
      }

      if (!converged && shouldStopEarlyFromConvergence({
        roundNum,
        maxRounds,
        previousStreams: previousRoundStreams,
        currentStreams: lastCompletedStreams,
        convergenceCheck: roundConvergence,
      })) {
        const adaptiveReason = roundConvergence?.reason
          ? `${roundConvergence.reason} Adaptive stop: responses changed minimally from the prior round.`
          : 'Adaptive stop: responses changed minimally from the prior round.';
        roundConvergence = {
          ...(roundConvergence || {}),
          converged: true,
          reason: adaptiveReason,
        };
        dispatchTurnAction('SET_CONVERGENCE', {
          roundIndex,
          convergenceCheck: roundConvergence,
        });
        converged = true;
        terminationReason = 'adaptive_convergence';
      }

      const refreshDecision = getLaterRoundSearchRefreshDecision({
        roundNum,
        maxRounds,
        webSearchEnabled: nativeWebSearchEnabled,
        canUseLegacySearchFallback,
        refreshesUsed: laterRoundSearchRefreshesUsed,
        results,
        convergenceCheck: roundConvergence,
      });
      if (refreshDecision.shouldRefresh) {
        laterRoundSearchRefreshesUsed += 1;
        hasLaterRoundSearchRefresh = true;
        const refreshedContext = await runLegacyWebSearch({
          convId,
          turnId,
          runId,
          userPrompt,
          attachments,
          videoUrls: routeInfo?.youtubeUrls || [],
          webSearchModel,
          apiKey,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) {
          terminationReason = 'cancelled';
          break;
        }
        if (refreshedContext) {
          webSearchContext = refreshedContext;
        }
      }

      // If we've hit max rounds without convergence
      if (roundNum === maxRounds && !converged) {
        terminationReason = 'max_rounds_reached';
      }

      if (lastCompletedStreams?.length > 0) {
        synthesisRounds.push({
          label: roundLabel,
          streams: lastCompletedStreams.map(stream => ({ ...stream })),
          convergenceCheck: roundConvergence,
        });
      }

      if (converged) {
        break;
      }
    }

    if (abortController.signal.aborted) {
      dispatchTurnAction('SET_DEBATE_METADATA', {
        metadata: { totalRounds, converged: false, terminationReason: 'cancelled' },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // Update debate metadata
    dispatchTurnAction('SET_DEBATE_METADATA', {
      metadata: {
        totalRounds,
        converged,
        terminationReason: terminationReason || 'max_rounds_reached',
      },
    });

    // ===== SYNTHESIS =====
    if (!lastCompletedStreams || lastCompletedStreams.length === 0) {
      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: '',
        status: 'error',
        error: 'All models failed. Cannot synthesize.',
        retryProgress: null,
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatchTurnAction('UPDATE_SYNTHESIS', {
      model: synthModel,
      content: '',
      status: 'streaming',
      error: null,
      retryProgress: null,
    });

    // Build synthesis from all completed rounds in this debate
    const roundsForSynthesis = synthesisRounds.length > 0
      ? synthesisRounds
      : [{
        label: `Final positions after ${totalRounds} round(s)`,
        streams: lastCompletedStreams,
        convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null,
      }];
    const synthesisMessages = buildMultiRoundSynthesisMessages({
      userPrompt,
      rounds: roundsForSynthesis,
      conversationHistory,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await runStreamWithFallback({
        model: synthModel,
        messages: synthesisMessages,
        apiKey,
        signal: abortController.signal,
        forceRefresh,
        onRetryProgress: (retryProgress) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: '',
            status: 'streaming',
            error: null,
            retryProgress,
          });
        },
        onChunk: (_delta, accumulated) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: accumulated,
            status: 'streaming',
            error: null,
          });
        },
      });

      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: synthesisContent,
        status: 'complete',
        error: null,
        usage: synthesisUsage,
        durationMs: synthesisDurationMs,
        retryProgress: null,
      });
      if (isFirstTurn) {
        requestAutoConversationTitle({
          conversationId: convId,
          userPrompt,
          synthesisContent,
          apiKey,
        });
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatchTurnAction('UPDATE_SYNTHESIS', {
          model: synthModel,
          content: '',
          status: 'error',
          error: err.message,
          retryProgress: null,
        });
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [state.apiKey, state.selectedModels, state.synthesizerModel, state.convergenceModel, state.convergenceOnFinalRound, state.maxDebateRounds, state.webSearchModel, state.strictWebSearch, state.activeConversationId, state.conversations, state.focusedMode, state.modelCatalog, state.capabilityRegistry, buildNativeWebSearchStrategy, prepareConversationHistory, recordFirstAnswerMetric, requestAutoConversationTitle, setAbortController]);

  /**
   * Run ensemble vote analysis (Phase 2) and streaming synthesis (Phase 3).
   * Extracted as a helper for reuse by startDirect and retry functions.
   */
  const runEnsembleAnalysisAndSynthesis = async ({
    convId, turnId, runId, userPrompt, completedStreams, conversationHistory,
    synthModel, convergenceModel, apiKey, abortController, focused = false, forceRefresh = false,
  }) => {
    const turnScope = { conversationId: convId, turnId, runId };
    const dispatchTurnAction = (type, payload = {}) => dispatchTurnScoped(turnScope, type, payload);
    // ===== PHASE 2: Vote Analysis =====
    dispatchTurnAction('SET_ENSEMBLE_RESULT', {
      ensembleResult: { status: 'analyzing', confidence: null, outliers: [], agreementAreas: [], disagreementAreas: [], modelWeights: {}, rawAnalysis: '', usage: null, durationMs: null },
    });

    let voteAnalysis = null;
    try {
      const voteMessages = buildEnsembleVoteMessages({ userPrompt, streams: completedStreams });
      const { content: voteContent, usage: voteUsage, durationMs: voteDurationMs } = await chatCompletion({
        model: convergenceModel,
        messages: voteMessages,
        apiKey,
        signal: abortController.signal,
      });

      voteAnalysis = parseEnsembleVoteResponse(voteContent);

      dispatchTurnAction('SET_ENSEMBLE_RESULT', {
        ensembleResult: {
          status: 'complete',
          ...voteAnalysis,
          rawAnalysis: voteContent,
          usage: voteUsage,
          durationMs: voteDurationMs,
        },
      });
    } catch (err) {
      if (abortController.signal.aborted) return false;
      // Vote analysis failed — continue with default weights
      voteAnalysis = { confidence: 50, outliers: [], agreementAreas: [], disagreementAreas: [], modelWeights: {} };
      dispatchTurnAction('SET_ENSEMBLE_RESULT', {
        ensembleResult: { status: 'error', ...voteAnalysis, rawAnalysis: '', usage: null, durationMs: null, error: err.message },
      });
    }

    if (abortController.signal.aborted) return false;

    // ===== PHASE 3: Streaming Synthesis =====
    dispatchTurnAction('UPDATE_SYNTHESIS', {
      model: synthModel,
      content: '',
      status: 'streaming',
      error: null,
      retryProgress: null,
    });

    const synthesisMessages = buildEnsembleSynthesisMessages({
      userPrompt,
      streams: completedStreams,
      voteAnalysis,
      conversationHistory,
      focused,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await runStreamWithFallback({
        model: synthModel,
        messages: synthesisMessages,
        apiKey,
        signal: abortController.signal,
        forceRefresh,
        onRetryProgress: (retryProgress) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: '',
            status: 'streaming',
            error: null,
            retryProgress,
          });
        },
        onChunk: (_delta, accumulated) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: accumulated,
            status: 'streaming',
            error: null,
          });
        },
      });

      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: synthesisContent,
        status: 'complete',
        error: null,
        usage: synthesisUsage,
        durationMs: synthesisDurationMs,
        retryProgress: null,
      });

      return synthesisContent;
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatchTurnAction('UPDATE_SYNTHESIS', {
          model: synthModel,
          content: '',
          status: 'error',
          error: err.message,
          retryProgress: null,
        });
      }
      return false;
    }
  };

  const startParallel = useCallback(async (userPrompt, {
    webSearch = false,
    attachments,
    focusedOverride,
    forceRefresh = false,
    forceLegacyWebSearch = false,
    modelOverrides,
    routeInfo = null,
  } = {}) => {
    const models = Array.isArray(modelOverrides) && modelOverrides.length > 0
      ? modelOverrides
      : state.selectedModels;
    const synthModel = state.synthesizerModel;
    const webSearchModel = state.webSearchModel;
    const strictWebSearch = state.strictWebSearch;
    const apiKey = state.apiKey;
    const focused = typeof focusedOverride === 'boolean' ? focusedOverride : state.focusedMode;
    const debateStartedAt = Date.now();
    let firstAnswerRecorded = false;

    // Create new conversation if none active
    let convId = state.activeConversationId;
    if (!convId) {
      convId = Date.now().toString();
      const title = createSeedTitle(userPrompt);
      dispatch({ type: 'NEW_CONVERSATION', payload: { id: convId, title } });
    }
    const existingConversation = state.conversations.find(c => c.id === convId);
    const isFirstTurn = !existingConversation || existingConversation.turns.length === 0;

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });

    const turnId = Date.now().toString();
    const runId = createRunId();
    const turn = {
      id: turnId,
      activeRunId: runId,
      userPrompt,
      timestamp: Date.now(),
      attachments: attachments || null,
      attachmentRouting: buildAttachmentRoutingForTurn(attachments, models),
      modelOverrides: Array.isArray(modelOverrides) ? modelOverrides : null,
      routeInfo,
      mode: 'parallel',
      focusedMode: focused,
      webSearchEnabled: Boolean(webSearch),
      rounds: [],
      synthesis: null,
      ensembleResult: null,
      debateMetadata: {
        totalRounds: 1,
        converged: false,
        terminationReason: 'parallel_only',
      },
    };

    dispatch({ type: 'ADD_TURN', payload: { conversationId: convId, turn } });
    const turnScope = { conversationId: convId, turnId, runId };
    const dispatchTurnAction = (type, payload = {}) => dispatchTurnScoped(turnScope, type, payload);

    const abortController = new AbortController();
    setAbortController(convId, abortController);

    // ===== WEB SEARCH (optional) =====
    let webSearchContext = '';
    const nativeWebSearchEnabled = Boolean(webSearch);
    const canUseLegacySearchFallback = Boolean(webSearchModel);
    const nativeSearchStrategy = buildNativeWebSearchStrategy({
      models,
      webSearchEnabled: nativeWebSearchEnabled,
      fallbackSearchModel: webSearchModel,
      forceLegacy: forceLegacyWebSearch,
    });

    const currentConv = state.conversations.find(c => c.id === convId);
    const contextMessages = prepareConversationHistory({
      conversationId: convId,
      conversation: currentConv,
      summaryModel: synthModel,
      apiKey,
      signal: abortController.signal,
    });

    if (nativeSearchStrategy.needsLegacyPreflight) {
      webSearchContext = await runLegacyWebSearch({
        convId,
        turnId,
        runId,
        userPrompt,
        attachments,
        videoUrls: routeInfo?.youtubeUrls || [],
        webSearchModel,
        apiKey,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }
    }

    const userMessageContent = formatWebSearchPrompt(userPrompt, webSearchContext, webSearchModel, {
      requireEvidence: nativeWebSearchEnabled,
      strictMode: strictWebSearch,
    });

    const conversationHistory = contextMessages;
    const focusedSystemMsg = focused ? [{ role: 'system', content: getFocusedEnsembleAnalysisPrompt() }] : [];
    const initialMessagesPerModel = buildInitialMessagesForModels({
      models,
      systemMessages: focusedSystemMsg,
      conversationHistory,
      userMessageContent,
      attachments,
      videoUrls: routeInfo?.youtubeUrls || [],
    });

    // ===== PARALLEL RESPONSES =====
    const roundLabel = focused ? 'Focused Responses' : 'Parallel Responses';
    const round = createRound({ roundNumber: 1, label: roundLabel, models });

    dispatchTurnAction('ADD_ROUND', { round });
    dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: 0, status: 'streaming' });

    let results = await runRound({
      models,
      messagesPerModel: initialMessagesPerModel,
      convId,
      turnId,
      runId,
      roundIndex: 0,
      apiKey,
      signal: abortController.signal,
      nativeWebSearch: nativeWebSearchEnabled && !webSearchContext
        ? nativeSearchStrategy.nativeWebSearch
        : false,
      searchVerification: nativeWebSearchEnabled
        ? {
          enabled: true,
          prompt: userPrompt,
          strictMode: strictWebSearch,
          mode: ({ useNativeSearchForModel }) => {
            if (webSearchContext) return 'legacy_context';
            return useNativeSearchForModel ? 'native' : 'native_skipped';
          },
          fallbackApplied: Boolean(webSearchContext && nativeSearchStrategy.fallbackReason),
          fallbackReason: webSearchContext ? nativeSearchStrategy.fallbackReason : null,
        }
        : null,
      forceRefresh,
      onModelSuccess: () => {
        if (firstAnswerRecorded) return;
        firstAnswerRecorded = true;
        recordFirstAnswerMetric(Date.now() - debateStartedAt);
      },
    });

    const shouldConsiderSearchFallback =
      nativeWebSearchEnabled &&
      !webSearchContext &&
      canUseLegacySearchFallback &&
      Boolean(nativeSearchStrategy.nativeWebSearch);
    const fallbackForNativeErrors = shouldConsiderSearchFallback
      ? shouldFallbackToLegacyWebSearch(results)
      : false;
    const fallbackForMissingEvidence = shouldConsiderSearchFallback
      ? shouldFallbackForMissingSearchEvidence(results)
      : false;

    if (shouldConsiderSearchFallback && (fallbackForNativeErrors || fallbackForMissingEvidence)) {
      const fallbackReason = fallbackForNativeErrors
        ? 'Native web-search/tool call failed.'
        : 'Native response lacked verifiable source evidence.';
      webSearchContext = await runLegacyWebSearch({
        convId,
        turnId,
        runId,
        userPrompt,
        attachments,
        videoUrls: routeInfo?.youtubeUrls || [],
        webSearchModel,
        apiKey,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }
      if (webSearchContext) {
        const fallbackUserMessageContent = formatWebSearchPrompt(userPrompt, webSearchContext, webSearchModel, {
          requireEvidence: nativeWebSearchEnabled,
          strictMode: strictWebSearch,
        });
        const fallbackInitialMessagesPerModel = buildInitialMessagesForModels({
          models,
          systemMessages: focusedSystemMsg,
          conversationHistory,
          userMessageContent: fallbackUserMessageContent,
          attachments,
          videoUrls: routeInfo?.youtubeUrls || [],
        });
        results = await runRound({
          models,
          messagesPerModel: fallbackInitialMessagesPerModel,
          convId,
          turnId,
          runId,
          roundIndex: 0,
          apiKey,
          signal: abortController.signal,
          nativeWebSearch: false,
          searchVerification: {
            enabled: true,
            prompt: userPrompt,
            strictMode: strictWebSearch,
            mode: 'legacy_context',
            fallbackApplied: true,
            fallbackReason,
          },
          forceRefresh,
          onModelSuccess: () => {
            if (firstAnswerRecorded) return;
            firstAnswerRecorded = true;
            recordFirstAnswerMetric(Date.now() - debateStartedAt);
          },
        });
      }
    }

    if (nativeWebSearchEnabled && strictWebSearch) {
      results = enforceStrictSearchEvidence({
        results,
        convId,
        turnId,
        runId,
        roundIndex: 0,
        strictMode: true,
      });
    }

    if (abortController.signal.aborted) {
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    const completedStreams = results
      .filter(r => r.content && !r.error)
      .map(r => ({ model: r.model, content: r.content, status: 'complete' }));

    if (completedStreams.length === 0) {
      dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: 0, status: 'error' });
      dispatchTurnAction('SET_DEBATE_METADATA', {
        metadata: { totalRounds: 1, converged: false, terminationReason: 'all_models_failed' },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: 0, status: 'complete' });
    dispatchTurnAction('SET_DEBATE_METADATA', {
      metadata: { totalRounds: 1, converged: false, terminationReason: 'parallel_only' },
    });

    if (isFirstTurn) {
      const titleSynthesisContent = buildTitleSynthesisContextFromStreams(completedStreams);
      if (titleSynthesisContent) {
        requestAutoConversationTitle({
          conversationId: convId,
          userPrompt,
          synthesisContent: titleSynthesisContent,
          apiKey,
        });
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [state.apiKey, state.selectedModels, state.synthesizerModel, state.webSearchModel, state.strictWebSearch, state.activeConversationId, state.conversations, state.focusedMode, state.modelCatalog, state.capabilityRegistry, buildNativeWebSearchStrategy, prepareConversationHistory, recordFirstAnswerMetric, requestAutoConversationTitle, setAbortController]);

  const startDirect = useCallback(async (userPrompt, {
    webSearch = false,
    attachments,
    focusedOverride,
    forceRefresh = false,
    forceLegacyWebSearch = false,
    modelOverrides,
    routeInfo = null,
  } = {}) => {
    const models = Array.isArray(modelOverrides) && modelOverrides.length > 0
      ? modelOverrides
      : state.selectedModels;
    const synthModel = state.synthesizerModel;
    const convergenceModel = state.convergenceModel;
    const webSearchModel = state.webSearchModel;
    const strictWebSearch = state.strictWebSearch;
    const apiKey = state.apiKey;
    const focused = typeof focusedOverride === 'boolean' ? focusedOverride : state.focusedMode;
    const debateStartedAt = Date.now();
    let firstAnswerRecorded = false;

    // Create new conversation if none active
    let convId = state.activeConversationId;
    if (!convId) {
      convId = Date.now().toString();
      const title = createSeedTitle(userPrompt);
      dispatch({ type: 'NEW_CONVERSATION', payload: { id: convId, title } });
    }
    const existingConversation = state.conversations.find(c => c.id === convId);
    const isFirstTurn = !existingConversation || existingConversation.turns.length === 0;

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });

    // Build ensemble vote turn
    const turnId = Date.now().toString();
    const runId = createRunId();
    const turn = {
      id: turnId,
      activeRunId: runId,
      userPrompt,
      timestamp: Date.now(),
      attachments: attachments || null,
      attachmentRouting: buildAttachmentRoutingForTurn(attachments, models),
      modelOverrides: Array.isArray(modelOverrides) ? modelOverrides : null,
      routeInfo,
      mode: 'direct',
      focusedMode: focused,
      webSearchEnabled: Boolean(webSearch),
      rounds: [],
      synthesis: {
        model: synthModel,
        content: '',
        status: 'pending',
        error: null,
      },
      ensembleResult: null,
      debateMetadata: {
        totalRounds: 1,
        converged: false,
        terminationReason: 'ensemble_vote',
      },
    };

    dispatch({ type: 'ADD_TURN', payload: { conversationId: convId, turn } });
    const turnScope = { conversationId: convId, turnId, runId };
    const dispatchTurnAction = (type, payload = {}) => dispatchTurnScoped(turnScope, type, payload);

    const abortController = new AbortController();
    setAbortController(convId, abortController);

    // ===== WEB SEARCH (optional) =====
    let webSearchContext = '';
    const nativeWebSearchEnabled = Boolean(webSearch);
    const canUseLegacySearchFallback = Boolean(webSearchModel);
    const nativeSearchStrategy = buildNativeWebSearchStrategy({
      models,
      webSearchEnabled: nativeWebSearchEnabled,
      fallbackSearchModel: webSearchModel,
      forceLegacy: forceLegacyWebSearch,
    });

    const currentConv = state.conversations.find(c => c.id === convId);
    const contextMessages = prepareConversationHistory({
      conversationId: convId,
      conversation: currentConv,
      summaryModel: synthModel,
      apiKey,
      signal: abortController.signal,
    });

    if (nativeSearchStrategy.needsLegacyPreflight) {
      webSearchContext = await runLegacyWebSearch({
        convId,
        turnId,
        runId,
        userPrompt,
        attachments,
        videoUrls: routeInfo?.youtubeUrls || [],
        webSearchModel,
        apiKey,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }
    }

    const userMessageContent = formatWebSearchPrompt(userPrompt, webSearchContext, webSearchModel, {
      requireEvidence: nativeWebSearchEnabled,
      strictMode: strictWebSearch,
    });

    const conversationHistory = contextMessages;
    const focusedSystemMsg = focused ? [{ role: 'system', content: getFocusedEnsembleAnalysisPrompt() }] : [];
    const initialMessagesPerModel = buildInitialMessagesForModels({
      models,
      systemMessages: focusedSystemMsg,
      conversationHistory,
      userMessageContent,
      attachments,
      videoUrls: routeInfo?.youtubeUrls || [],
    });

    // ===== PHASE 1: All debate models in parallel =====
    const roundLabel = focused ? 'Focused Analyses' : 'Independent Analyses';
    const round = createRound({ roundNumber: 1, label: roundLabel, models });

    dispatchTurnAction('ADD_ROUND', { round });
    dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: 0, status: 'streaming' });

    let results = await runRound({
      models,
      messagesPerModel: initialMessagesPerModel,
      convId,
      turnId,
      runId,
      roundIndex: 0,
      apiKey,
      signal: abortController.signal,
      nativeWebSearch: nativeWebSearchEnabled && !webSearchContext
        ? nativeSearchStrategy.nativeWebSearch
        : false,
      searchVerification: nativeWebSearchEnabled
        ? {
          enabled: true,
          prompt: userPrompt,
          strictMode: strictWebSearch,
          mode: ({ useNativeSearchForModel }) => {
            if (webSearchContext) return 'legacy_context';
            return useNativeSearchForModel ? 'native' : 'native_skipped';
          },
          fallbackApplied: Boolean(webSearchContext && nativeSearchStrategy.fallbackReason),
          fallbackReason: webSearchContext ? nativeSearchStrategy.fallbackReason : null,
        }
        : null,
      forceRefresh,
      onModelSuccess: () => {
        if (firstAnswerRecorded) return;
        firstAnswerRecorded = true;
        recordFirstAnswerMetric(Date.now() - debateStartedAt);
      },
    });

    const shouldConsiderSearchFallback =
      nativeWebSearchEnabled &&
      !webSearchContext &&
      canUseLegacySearchFallback &&
      Boolean(nativeSearchStrategy.nativeWebSearch);
    const fallbackForNativeErrors = shouldConsiderSearchFallback
      ? shouldFallbackToLegacyWebSearch(results)
      : false;
    const fallbackForMissingEvidence = shouldConsiderSearchFallback
      ? shouldFallbackForMissingSearchEvidence(results)
      : false;

    if (shouldConsiderSearchFallback && (fallbackForNativeErrors || fallbackForMissingEvidence)) {
      const fallbackReason = fallbackForNativeErrors
        ? 'Native web-search/tool call failed.'
        : 'Native response lacked verifiable source evidence.';
      webSearchContext = await runLegacyWebSearch({
        convId,
        turnId,
        runId,
        userPrompt,
        attachments,
        videoUrls: routeInfo?.youtubeUrls || [],
        webSearchModel,
        apiKey,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }
      if (webSearchContext) {
        const fallbackUserMessageContent = formatWebSearchPrompt(userPrompt, webSearchContext, webSearchModel, {
          requireEvidence: nativeWebSearchEnabled,
          strictMode: strictWebSearch,
        });
        const fallbackInitialMessagesPerModel = buildInitialMessagesForModels({
          models,
          systemMessages: focusedSystemMsg,
          conversationHistory,
          userMessageContent: fallbackUserMessageContent,
          attachments,
          videoUrls: routeInfo?.youtubeUrls || [],
        });
        results = await runRound({
          models,
          messagesPerModel: fallbackInitialMessagesPerModel,
          convId,
          turnId,
          runId,
          roundIndex: 0,
          apiKey,
          signal: abortController.signal,
          nativeWebSearch: false,
          searchVerification: {
            enabled: true,
            prompt: userPrompt,
            strictMode: strictWebSearch,
            mode: 'legacy_context',
            fallbackApplied: true,
            fallbackReason,
          },
          forceRefresh,
          onModelSuccess: () => {
            if (firstAnswerRecorded) return;
            firstAnswerRecorded = true;
            recordFirstAnswerMetric(Date.now() - debateStartedAt);
          },
        });
      }
    }

    if (nativeWebSearchEnabled && strictWebSearch) {
      results = enforceStrictSearchEvidence({
        results,
        convId,
        turnId,
        runId,
        roundIndex: 0,
        strictMode: true,
      });
    }

    if (abortController.signal.aborted) {
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    const completedStreams = results
      .filter(r => r.content && !r.error)
      .map(r => ({ model: r.model, content: r.content, status: 'complete' }));

    if (completedStreams.length === 0) {
      dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: 0, status: 'error' });
      dispatchTurnAction('SET_DEBATE_METADATA', {
        metadata: { totalRounds: 1, converged: false, terminationReason: 'all_models_failed' },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: 0, status: 'complete' });

    // ===== PHASE 2 + 3: Vote Analysis & Synthesis =====
    const synthesisContent = await runEnsembleAnalysisAndSynthesis({
      convId, turnId, runId, userPrompt, completedStreams, conversationHistory,
      synthModel, convergenceModel, apiKey, abortController, focused, forceRefresh,
    });
    if (synthesisContent && isFirstTurn) {
      requestAutoConversationTitle({
        conversationId: convId,
        userPrompt,
        synthesisContent,
        apiKey,
      });
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [state.apiKey, state.selectedModels, state.synthesizerModel, state.convergenceModel, state.webSearchModel, state.strictWebSearch, state.activeConversationId, state.conversations, state.focusedMode, state.modelCatalog, state.capabilityRegistry, buildNativeWebSearchStrategy, prepareConversationHistory, recordFirstAnswerMetric, requestAutoConversationTitle, setAbortController]);

  const cancelDebate = useCallback((conversationId = null) => {
    const normalizedConversationId = (
      typeof conversationId === 'string' ||
      typeof conversationId === 'number'
    )
      ? conversationId
      : null;
    const targetConversationId = normalizedConversationId || activeConversation?.id || null;
    if (!targetConversationId) return;

    abortConversationRun(targetConversationId);

    const targetConversation = state.conversations.find((conversation) => conversation.id === targetConversationId)
      || (activeConversation?.id === targetConversationId ? activeConversation : null);

    if (targetConversation?.turns?.length) {
      const lastTurn = targetConversation.turns[targetConversation.turns.length - 1];
      if (Array.isArray(lastTurn.rounds) && lastTurn.rounds.length > 0) {
        lastTurn.rounds.forEach((round, roundIndex) => {
          const streams = Array.isArray(round?.streams) ? round.streams : [];
          const hasLiveStreams = streams.some((stream) => isLiveStatus(stream?.status));

          if (isLiveStatus(round?.status) || hasLiveStreams) {
            dispatch({
              type: 'UPDATE_ROUND_STATUS',
              payload: {
                conversationId: targetConversationId,
                roundIndex,
                status: 'error',
              },
            });
          }

          streams.forEach((stream, streamIndex) => {
            if (!isLiveStatus(stream?.status)) return;
            dispatch({
              type: 'UPDATE_ROUND_STREAM',
              payload: {
                conversationId: targetConversationId,
                roundIndex,
                streamIndex,
                content: stream.content || '',
                status: 'error',
                error: 'Cancelled',
                errorKind: 'cancelled',
                retryProgress: null,
                reasoning: stream.reasoning,
              },
            });
          });
        });
      }
      if (isLiveStatus(lastTurn.synthesis?.status)) {
        dispatch({
          type: 'UPDATE_SYNTHESIS',
          payload: {
            conversationId: targetConversationId,
            model: lastTurn.synthesis.model || state.synthesizerModel,
            content: lastTurn.synthesis.content || '',
            status: 'error',
            error: 'Cancelled',
            retryProgress: null,
            usage: lastTurn.synthesis.usage,
            durationMs: lastTurn.synthesis.durationMs,
          },
        });
      }
      if (isLiveStatus(lastTurn.ensembleResult?.status)) {
        dispatch({
          type: 'SET_ENSEMBLE_RESULT',
          payload: {
            conversationId: targetConversationId,
            ensembleResult: {
              ...lastTurn.ensembleResult,
              status: 'error',
              error: 'Cancelled',
            },
          },
        });
      }
      if (isLiveStatus(lastTurn.webSearchResult?.status)) {
        dispatch({
          type: 'SET_WEB_SEARCH_RESULT',
          payload: {
            conversationId: targetConversationId,
            result: {
              ...lastTurn.webSearchResult,
              status: 'error',
              error: 'Cancelled',
            },
          },
        });
      }
    }
    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [activeConversation, abortConversationRun, dispatch, state.conversations, state.synthesizerModel]);

  const editLastTurn = useCallback(() => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    dispatch({
      type: 'SET_EDITING_TURN',
      payload: { prompt: lastTurn.userPrompt, attachments: lastTurn.attachments, conversationId: activeConversation.id },
    });
  }, [activeConversation]);

  const retryLastTurn = useCallback((options = {}) => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const forceRefresh = Boolean(options.forceRefresh);
    const forceLegacyWebSearch = Boolean(options.forceLegacyWebSearch);
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    const prompt = lastTurn.userPrompt;
    const turnAttachments = lastTurn.attachments;
    const turnMode = lastTurn.mode;
    const webSearch = typeof lastTurn.webSearchEnabled === 'boolean'
      ? lastTurn.webSearchEnabled
      : state.webSearchEnabled;
    const focusedOverride = typeof lastTurn.focusedMode === 'boolean'
      ? lastTurn.focusedMode
      : state.focusedMode;
    dispatch({ type: 'REMOVE_LAST_TURN', payload: activeConversation.id });
    const opts = {
      webSearch,
      attachments: turnAttachments || undefined,
      focusedOverride,
      forceRefresh,
      forceLegacyWebSearch,
      modelOverrides: Array.isArray(lastTurn.modelOverrides) ? lastTurn.modelOverrides : undefined,
      routeInfo: lastTurn.routeInfo || undefined,
    };
    if (turnMode === 'direct') {
      startDirect(prompt, opts);
    } else if (turnMode === 'parallel') {
      startParallel(prompt, opts);
    } else {
      startDebate(prompt, opts);
    }
  }, [activeConversation, startDebate, startDirect, startParallel, state.webSearchEnabled, state.focusedMode]);

  const retrySynthesis = useCallback(async (options = {}) => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const forceRefresh = Boolean(options.forceRefresh);
    const convId = activeConversation.id;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    if (!lastTurn.rounds || lastTurn.rounds.length === 0) return;

    const userPrompt = lastTurn.userPrompt;
    const apiKey = state.apiKey;
    const synthModel = state.synthesizerModel;
    const convergModel = state.convergenceModel;
    const turnFocused = typeof lastTurn.focusedMode === 'boolean'
      ? lastTurn.focusedMode
      : state.focusedMode;

    // Gather completed streams from the final round
    const finalRound = lastTurn.rounds[lastTurn.rounds.length - 1];
    const lastCompletedStreams = finalRound.streams
      .filter(s => s.content && (s.status === 'complete' || s.error))
      .map(s => ({ model: s.model, content: s.content, status: 'complete' }));

    if (lastCompletedStreams.length === 0) return;

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });
    const turnId = lastTurn.id;
    const runId = createRunId();
    dispatch({ type: 'SET_TURN_RUN_STATE', payload: { conversationId: convId, turnId, runId } });
    const turnScope = { conversationId: convId, turnId, runId };
    const dispatchTurnAction = (type, payload = {}) => dispatchTurnScoped(turnScope, type, payload);

    const abortController = new AbortController();
    setAbortController(convId, abortController);

    // Build conversation context (excluding current turn)
    const convForContext = { ...activeConversation, turns: activeConversation.turns.slice(0, -1) };
    const { messages: contextMessages } = buildConversationContext({
      conversation: convForContext,
      runningSummary: activeConversation.runningSummary || null,
      summarizedTurnCount: activeConversation.summarizedTurnCount || 0,
      pendingSummaryUntilTurnCount: activeConversation.pendingSummaryUntilTurnCount || activeConversation.summarizedTurnCount || 0,
    });
    const conversationHistory = contextMessages;

    // Ensemble mode (direct turns): re-run vote analysis + synthesis
    if (lastTurn.mode === 'direct') {
      await runEnsembleAnalysisAndSynthesis({
        convId, turnId, runId, userPrompt, completedStreams: lastCompletedStreams, conversationHistory,
        synthModel, convergenceModel: convergModel, apiKey, abortController, focused: turnFocused, forceRefresh,
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // Debate mode: use the original multi-round synthesis path
    const converged = lastTurn.debateMetadata?.converged || false;
    const totalRounds = lastTurn.debateMetadata?.totalRounds || lastTurn.rounds.length;
    const roundsForSynthesis = toSynthesisRounds(lastTurn.rounds, totalRounds);

    dispatchTurnAction('UPDATE_SYNTHESIS', {
      model: synthModel,
      content: lastTurn.synthesis?.content || '',
      status: 'streaming',
      error: null,
      retryProgress: null,
    });

    const synthesisMessages = buildMultiRoundSynthesisMessages({
      userPrompt,
      rounds: roundsForSynthesis.length > 0
        ? roundsForSynthesis
        : [{
          label: `Final positions after ${totalRounds} round(s)`,
          streams: lastCompletedStreams,
          convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null,
        }],
      conversationHistory,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await runStreamWithFallback({
        model: synthModel,
        messages: synthesisMessages,
        apiKey,
        signal: abortController.signal,
        forceRefresh,
        onRetryProgress: (retryProgress) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: lastTurn.synthesis?.content || '',
            status: 'streaming',
            error: null,
            retryProgress,
          });
        },
        onChunk: (_delta, accumulated) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: accumulated,
            status: 'streaming',
            error: null,
          });
        },
      });
      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: synthesisContent,
        status: 'complete',
        error: null,
        usage: synthesisUsage,
        durationMs: synthesisDurationMs,
        retryProgress: null,
      });
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatchTurnAction('UPDATE_SYNTHESIS', {
          model: synthModel,
          content: lastTurn.synthesis?.content || '',
          status: 'error',
          error: err.message,
          retryProgress: null,
        });
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [activeConversation, state.apiKey, state.synthesizerModel, state.convergenceModel, state.focusedMode, state.modelCatalog, state.capabilityRegistry, setAbortController]);

  const branchFromRound = useCallback((roundIndex) => {
    if (!activeConversation || !activeConversation.id) return;
    dispatch({
      type: 'BRANCH_FROM_ROUND',
      payload: {
        conversationId: activeConversation.id,
        roundIndex,
      },
    });
  }, [activeConversation, dispatch]);

  const retryRound = useCallback(async (roundIndex, options = {}) => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const forceRefresh = Boolean(options.forceRefresh);
    const retryErroredCompleted = Boolean(options.retryErroredCompleted);
    const redoRound = Boolean(options.redoRound);
    const forceLegacyWebSearch = Boolean(options.forceLegacyWebSearch);
    const preferredStreamIndices = Array.isArray(options.streamIndices) ? options.streamIndices : [];
    const replacementModels = options.replacementModels && typeof options.replacementModels === 'object'
      ? options.replacementModels
      : null;
    const convId = activeConversation.id;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    if (!lastTurn.rounds || roundIndex >= lastTurn.rounds.length) return;

    const userPrompt = lastTurn.userPrompt;
    const attachments = lastTurn.attachments;
    const targetRound = lastTurn.rounds[roundIndex];
    const models = targetRound.streams.map((stream, index) => (
      getReplacementModelForStream(replacementModels, index) || stream.model
    ));

    const apiKey = state.apiKey;
    const synthModel = state.synthesizerModel;
    const convergenceModel = state.convergenceModel;
    const maxRounds = state.maxDebateRounds;
    const strictWebSearch = state.strictWebSearch;
    const turnFocused = typeof lastTurn.focusedMode === 'boolean'
      ? lastTurn.focusedMode
      : state.focusedMode;
    const turnId = lastTurn.id;
    const runId = createRunId();
    const turnScope = { conversationId: convId, turnId, runId };
    const dispatchTurnAction = (type, payload = {}) => dispatchTurnScoped(turnScope, type, payload);

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });
    dispatch({ type: 'SET_TURN_RUN_STATE', payload: { conversationId: convId, turnId, runId } });
    dispatchTurnAction('TRUNCATE_ROUNDS', { keepCount: roundIndex + 1 });
    dispatchTurnAction('RESET_SYNTHESIS', { model: synthModel, preserveContent: true });

    const abortController = new AbortController();
    setAbortController(convId, abortController);

    // Build conversation context (excluding current turn)
    const convForContext = { ...activeConversation, turns: activeConversation.turns.slice(0, -1) };
    const { messages: contextMessages } = buildConversationContext({
      conversation: convForContext,
      runningSummary: activeConversation.runningSummary || null,
      summarizedTurnCount: activeConversation.summarizedTurnCount || 0,
      pendingSummaryUntilTurnCount: activeConversation.pendingSummaryUntilTurnCount || activeConversation.summarizedTurnCount || 0,
    });
    const conversationHistory = contextMessages;

    // Build web search context if present
    const webSearchResult = lastTurn.webSearchResult;
    let webSearchCtx = webSearchResult?.status === 'complete' ? webSearchResult.content : '';
    const wsModel = webSearchResult?.model || '';
    const fallbackSearchModel = wsModel || state.webSearchModel;
    const nativeSearchStrategy = buildNativeWebSearchStrategy({
      models,
      webSearchEnabled: Boolean(lastTurn.webSearchEnabled),
      fallbackSearchModel,
      forceLegacy: roundIndex === 0 && forceLegacyWebSearch,
    });
    const canUseLaterRoundSearchFallback = Boolean(fallbackSearchModel);
    const hasExistingLaterRoundRefresh = didUseLaterRoundSearchRefresh(lastTurn.rounds);
    let laterRoundSearchRefreshesUsed = hasExistingLaterRoundRefresh
      ? MAX_LATER_ROUND_SEARCH_REFRESHES
      : 0;
    let hasLaterRoundSearchRefresh = hasExistingLaterRoundRefresh;
    let legacySearchPreflightAttempted = false;
    if (roundIndex === 0 && nativeSearchStrategy.needsLegacyPreflight) {
      legacySearchPreflightAttempted = true;
      webSearchCtx = await runLegacyWebSearch({
        convId,
        turnId,
        runId,
        userPrompt,
        attachments,
        videoUrls: lastTurn.routeInfo?.youtubeUrls || [],
        webSearchModel: fallbackSearchModel,
        apiKey,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }
    }
    const useNativeWebSearch = roundIndex === 0 && Boolean(lastTurn.webSearchEnabled) && !webSearchCtx
      ? nativeSearchStrategy.nativeWebSearch
      : false;
    const userMessageContent = formatWebSearchPrompt(userPrompt, webSearchCtx, wsModel, {
      requireEvidence: Boolean(lastTurn.webSearchEnabled),
      strictMode: strictWebSearch,
    });
    const focusedSystemMsg = turnFocused && lastTurn.mode === 'direct'
      ? [{ role: 'system', content: getFocusedEnsembleAnalysisPrompt() }]
      : [];
    let initialMessagesPerModel = buildInitialMessagesForModels({
      models,
      systemMessages: focusedSystemMsg,
      conversationHistory,
      userMessageContent,
      attachments,
      videoUrls: lastTurn.routeInfo?.youtubeUrls || [],
    });

    // Get previous round streams for rebuttal context
    let previousRoundStreams = null;
    if (roundIndex > 0) {
      const prevRound = lastTurn.rounds[roundIndex - 1];
      previousRoundStreams = prevRound.streams
        .filter(s => s.content && s.status === 'complete')
        .map(s => ({ model: s.model, content: s.content, status: 'complete' }));
    }

    // Identify which streams need re-running (failed, stuck, or pending)
    const failedIndices = getRoundRepairStreamIndices({
      streams: targetRound.streams,
      redoRound,
      retryErroredCompleted,
      preferredStreamIndices,
    });

    // === ENSEMBLE (direct mode) retry: re-run all streams then vote + synthesis ===
    if (lastTurn.mode === 'direct') {
      dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'streaming' });

      let results = await runRound({
        models,
        messagesPerModel: initialMessagesPerModel,
        convId,
        turnId,
        runId,
        roundIndex,
        apiKey,
        signal: abortController.signal,
        nativeWebSearch: roundIndex === 0 && useNativeWebSearch,
        searchVerification: roundIndex === 0 && Boolean(lastTurn.webSearchEnabled)
          ? {
            enabled: true,
            prompt: userPrompt,
            strictMode: strictWebSearch,
            mode: ({ useNativeSearchForModel }) => {
              if (webSearchCtx) return 'legacy_context';
              return useNativeSearchForModel ? 'native' : 'native_skipped';
            },
            fallbackApplied: Boolean(webSearchCtx && nativeSearchStrategy.fallbackReason),
            fallbackReason: webSearchCtx ? nativeSearchStrategy.fallbackReason : null,
          }
          : null,
        forceRefresh,
      });

      const shouldConsiderSearchFallback =
        roundIndex === 0 &&
        Boolean(useNativeWebSearch) &&
        Boolean(fallbackSearchModel) &&
        !legacySearchPreflightAttempted;
      const fallbackForNativeErrors = shouldConsiderSearchFallback
        ? shouldFallbackToLegacyWebSearch(results)
        : false;
      const fallbackForMissingEvidence = shouldConsiderSearchFallback
        ? shouldFallbackForMissingSearchEvidence(results)
        : false;

      if (shouldConsiderSearchFallback && (fallbackForNativeErrors || fallbackForMissingEvidence)) {
        const fallbackReason = fallbackForNativeErrors
          ? 'Native web-search/tool call failed.'
          : 'Native response lacked verifiable source evidence.';
        webSearchCtx = await runLegacyWebSearch({
          convId,
          turnId,
          runId,
          userPrompt,
          attachments,
          videoUrls: lastTurn.routeInfo?.youtubeUrls || [],
          webSearchModel: fallbackSearchModel,
          apiKey,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }
        if (webSearchCtx) {
          const fallbackPrompt = formatWebSearchPrompt(userPrompt, webSearchCtx, fallbackSearchModel, {
            requireEvidence: Boolean(lastTurn.webSearchEnabled),
            strictMode: strictWebSearch,
          });
          initialMessagesPerModel = buildInitialMessagesForModels({
            models,
            systemMessages: focusedSystemMsg,
            conversationHistory,
            userMessageContent: fallbackPrompt,
            attachments,
            videoUrls: lastTurn.routeInfo?.youtubeUrls || [],
          });
          results = await runRound({
            models,
            messagesPerModel: initialMessagesPerModel,
            convId,
            turnId,
            runId,
            roundIndex,
            apiKey,
            signal: abortController.signal,
            nativeWebSearch: false,
            searchVerification: {
              enabled: true,
              prompt: userPrompt,
              strictMode: strictWebSearch,
              mode: 'legacy_context',
              fallbackApplied: true,
              fallbackReason,
            },
            forceRefresh,
          });
        }
      }

      if (roundIndex === 0 && Boolean(lastTurn.webSearchEnabled) && strictWebSearch) {
        results = enforceStrictSearchEvidence({
          results,
          convId,
          turnId,
          runId,
          roundIndex,
          strictMode: true,
        });
      }

      if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }

      const completedStreams = results
        .filter(r => r.content && !r.error)
        .map(r => ({ model: r.model, content: r.content, status: 'complete' }));

      if (completedStreams.length === 0) {
        dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'error' });
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }

      dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'complete' });

      await runEnsembleAnalysisAndSynthesis({
        convId, turnId, runId, userPrompt, completedStreams, conversationHistory,
        synthModel, convergenceModel, apiKey, abortController, focused: turnFocused, forceRefresh,
      });

      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // If all streams are actually complete, just continue from this round
    // (re-run convergence + subsequent rounds + synthesis)
    if (failedIndices.length === 0) {
      // Build lastCompletedStreams from existing data
      let lastCompletedStreams = targetRound.streams
        .filter(s => s.content && s.status === 'complete')
        .map(s => ({ model: s.model, content: s.content, status: 'complete' }));

      dispatchTurnAction('UPDATE_ROUND_STATUS', {
        roundIndex,
        status: lastCompletedStreams.length > 0 ? 'complete' : 'error',
      });

      // Skip ahead to convergence + continuation
      let converged = false;
      let terminationReason = null;
      let totalRounds = roundIndex + 1;
      let currentRoundIndex = roundIndex;
      const synthesisRounds = toSynthesisRounds(lastTurn.rounds, roundIndex);
      let currentRoundConvergence = targetRound.convergenceCheck || null;

      // Convergence check on current round
      if (shouldRunConvergenceCheck(totalRounds, maxRounds, runConvergenceOnFinalRound) && !abortController.signal.aborted) {
        dispatchTurnAction('SET_CONVERGENCE', {
          roundIndex: currentRoundIndex,
          convergenceCheck: { converged: null, reason: 'Checking...' },
        });
        try {
          const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: totalRounds });
          const { content: cResponse, usage: cUsage } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
          const parsed = parseConvergenceResponse(cResponse);
          parsed.rawResponse = cResponse;
          parsed.usage = cUsage || null;
          currentRoundConvergence = parsed;
          dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: parsed });
          if (parsed.converged) { converged = true; terminationReason = 'converged'; }
        } catch (err) {
          if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }
          currentRoundConvergence = { converged: false, reason: 'Convergence check failed: ' + err.message };
          dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: currentRoundConvergence });
        }
      }

      const currentRoundSummary = buildSynthesisRoundSummary({
        label: targetRound.label || getRoundLabel(roundIndex + 1),
        roundNumber: roundIndex + 1,
        streams: lastCompletedStreams,
        convergenceCheck: currentRoundConvergence,
      });
      if (currentRoundSummary) {
        synthesisRounds.push(currentRoundSummary);
      }

      // Continue with additional rounds if not converged
      if (!converged && !abortController.signal.aborted && totalRounds < maxRounds) {
        for (let roundNum = totalRounds + 1; roundNum <= maxRounds; roundNum++) {
          if (abortController.signal.aborted) break;
          const roundLabel = getRoundLabel(roundNum);
          const round = createRound({ roundNumber: roundNum, label: roundLabel, models });
          currentRoundIndex = roundNum - 1;
          let roundConvergence = null;
          dispatchTurnAction('ADD_ROUND', { round });
          dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: currentRoundIndex, status: 'streaming' });
          const messagesPerModel = models.map(() =>
            buildRebuttalMessages({
              userPrompt,
              previousRoundStreams: lastCompletedStreams,
              roundNumber: roundNum,
              conversationHistory,
              focused: turnFocused,
              webSearchContext: webSearchCtx,
              webSearchModel: fallbackSearchModel,
            })
          );
          const roundSearchVerification = Boolean(lastTurn.webSearchEnabled)
            ? {
              enabled: true,
              prompt: userPrompt,
              strictMode: false,
              mode: hasLaterRoundSearchRefresh ? 'refresh_context' : (webSearchCtx ? 'legacy_context' : 'debate_rebuttal'),
            }
            : null;
          const results = await runRound({
            models,
            messagesPerModel,
            convId,
            turnId,
            runId,
            roundIndex: currentRoundIndex,
            apiKey,
            signal: abortController.signal,
            searchVerification: roundSearchVerification,
            forceRefresh,
          });
          if (abortController.signal.aborted) { terminationReason = 'cancelled'; break; }
          const completedStreams = results.filter(r => r.content && !r.error);
          if (completedStreams.length === 0) {
            dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: currentRoundIndex, status: 'error' });
            terminationReason = 'all_models_failed'; totalRounds = roundNum; break;
          }
          if (completedStreams.length < models.length) {
            for (const result of results) {
              if (result.error && !result.content) {
                const prev = lastCompletedStreams.find(s => s.model === result.model);
                if (prev) {
                  result.content = prev.content;
                  dispatchTurnAction('UPDATE_ROUND_STREAM', {
                    roundIndex: currentRoundIndex,
                    streamIndex: result.index,
                    content: prev.content,
                    status: 'complete',
                    error: 'Failed this round - showing previous response',
                    errorKind: result.errorKind || 'failed',
                    outcome: 'using_previous_response',
                    retryProgress: null,
                  });
                }
              }
            }
          }
          lastCompletedStreams = results.filter(r => r.content).map(r => ({ model: r.model, content: r.content, status: 'complete' }));
          dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: currentRoundIndex, status: 'complete' });
          totalRounds = roundNum;
          if (shouldRunConvergenceCheck(roundNum, maxRounds, runConvergenceOnFinalRound)) {
            if (abortController.signal.aborted) break;
            dispatchTurnAction('SET_CONVERGENCE', {
              roundIndex: currentRoundIndex,
              convergenceCheck: { converged: null, reason: 'Checking...' },
            });
            try {
              const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: roundNum });
              const { content: cResponse, usage: cUsage } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
              const parsed = parseConvergenceResponse(cResponse);
              parsed.rawResponse = cResponse;
              parsed.usage = cUsage || null;
              roundConvergence = parsed;
              dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: parsed });
              if (parsed.converged) {
                converged = true;
                terminationReason = 'converged';
                const convergedRoundSummary = buildSynthesisRoundSummary({
                  label: roundLabel,
                  roundNumber: roundNum,
                  streams: lastCompletedStreams,
                  convergenceCheck: roundConvergence,
                });
                if (convergedRoundSummary) {
                  synthesisRounds.push(convergedRoundSummary);
                }
                break;
              }
            } catch (err) {
              if (abortController.signal.aborted) break;
              roundConvergence = { converged: false, reason: 'Convergence check failed: ' + err.message };
              dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: roundConvergence });
            }
          }
          const refreshDecision = getLaterRoundSearchRefreshDecision({
            roundNum,
            maxRounds,
            webSearchEnabled: Boolean(lastTurn.webSearchEnabled),
            canUseLegacySearchFallback: canUseLaterRoundSearchFallback,
            refreshesUsed: laterRoundSearchRefreshesUsed,
            results,
            convergenceCheck: roundConvergence,
          });
          if (refreshDecision.shouldRefresh) {
            laterRoundSearchRefreshesUsed += 1;
            hasLaterRoundSearchRefresh = true;
            const refreshedContext = await runLegacyWebSearch({
              convId,
              turnId,
              runId,
              userPrompt,
              attachments,
              videoUrls: lastTurn.routeInfo?.youtubeUrls || [],
              webSearchModel: fallbackSearchModel,
              apiKey,
              signal: abortController.signal,
            });
            if (abortController.signal.aborted) { terminationReason = 'cancelled'; break; }
            if (refreshedContext) {
              webSearchCtx = refreshedContext;
            }
          }
          const roundSummary = buildSynthesisRoundSummary({
            label: roundLabel,
            roundNumber: roundNum,
            streams: lastCompletedStreams,
            convergenceCheck: roundConvergence,
          });
          if (roundSummary) {
            synthesisRounds.push(roundSummary);
          }
          if (roundNum === maxRounds && !converged) terminationReason = 'max_rounds_reached';
        }
      } else if (totalRounds >= maxRounds) {
        terminationReason = terminationReason || 'max_rounds_reached';
      }

    if (abortController.signal.aborted) {
      dispatchTurnAction('SET_DEBATE_METADATA', {
        metadata: { totalRounds, converged: false, terminationReason: 'cancelled' },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatchTurnAction('SET_DEBATE_METADATA', {
      metadata: { totalRounds, converged, terminationReason: terminationReason || 'max_rounds_reached' },
    });

    // Synthesis
    if (!lastCompletedStreams || lastCompletedStreams.length === 0) {
      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: '',
        status: 'error',
        error: 'All models failed. Cannot synthesize.',
        retryProgress: null,
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }
    dispatchTurnAction('UPDATE_SYNTHESIS', {
      model: synthModel,
      content: lastTurn.synthesis?.content || '',
      status: 'streaming',
      error: null,
      retryProgress: null,
    });
      const finalRoundSummary = {
        label: `Final positions after ${totalRounds} round(s)`,
        streams: lastCompletedStreams,
        convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null,
      };
      const roundsForSynthesis = synthesisRounds.length > 0
        ? [...synthesisRounds, finalRoundSummary]
        : [finalRoundSummary];
      const synthesisMessages = buildMultiRoundSynthesisMessages({
        userPrompt,
        rounds: roundsForSynthesis,
        conversationHistory,
      });
      try {
        const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await runStreamWithFallback({
          model: synthModel, messages: synthesisMessages, apiKey, signal: abortController.signal,
          forceRefresh,
          onRetryProgress: (retryProgress) => {
            dispatchTurnAction('UPDATE_SYNTHESIS', {
              model: synthModel,
              content: lastTurn.synthesis?.content || '',
              status: 'streaming',
              error: null,
              retryProgress,
            });
          },
          onChunk: (_delta, accumulated) => {
            dispatchTurnAction('UPDATE_SYNTHESIS', {
              model: synthModel,
              content: accumulated,
              status: 'streaming',
              error: null,
            });
          },
        });
        dispatchTurnAction('UPDATE_SYNTHESIS', {
          model: synthModel,
          content: synthesisContent,
          status: 'complete',
          error: null,
          usage: synthesisUsage,
          durationMs: synthesisDurationMs,
          retryProgress: null,
        });
      } catch (err) {
        if (!abortController.signal.aborted) {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: lastTurn.synthesis?.content || '',
            status: 'error',
            error: err.message,
            retryProgress: null,
          });
        }
      }
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // === Re-run only failed/stuck streams in parallel ===
    dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'streaming' });

    const retryResults = await Promise.allSettled(
      failedIndices.map(async (si) => {
        const model = models[si];
        const replacementModel = getReplacementModelForStream(replacementModels, si);
        const previousStream = targetRound.streams[si];
        const route = resolveModelRoute(model, models);
        const effectiveModel = route.effectiveModel || model;
        const routeInfo = route.routeInfo || null;
        const useNativeSearchForModel = roundIndex === 0
          && (typeof useNativeWebSearch === 'function'
            ? Boolean(useNativeWebSearch(model))
            : Boolean(useNativeWebSearch));
        const cachePolicy = roundIndex === 0 && Boolean(lastTurn.webSearchEnabled)
          ? getSearchResponseCachePolicy({
            prompt: userPrompt,
            searchEnabled: true,
            defaultTtlMs: RESPONSE_CACHE_TTL_MS,
          })
          : null;
        // Build messages for this model
        let modelMessages;
        if (roundIndex === 0) {
          modelMessages = initialMessagesPerModel[si] || initialMessagesPerModel[0] || [];
        } else {
          modelMessages = buildRebuttalMessages({
            userPrompt,
            previousRoundStreams,
            roundNumber: roundIndex + 1,
            conversationHistory,
            focused: turnFocused,
            webSearchContext: webSearchCtx,
            webSearchModel: fallbackSearchModel,
          });
        }

        dispatchTurnAction('UPDATE_ROUND_STREAM', {
          roundIndex,
          streamIndex: si,
          ...buildStreamRefreshState(previousStream, model, {
            preserveContent: !replacementModel,
            routeInfo,
          }),
        });

        try {
          const { content, reasoning, usage, durationMs, fromCache, searchMetadata } = await runStreamWithFallback({
            model: effectiveModel,
            messages: modelMessages,
            apiKey,
            signal: abortController.signal,
            nativeWebSearch: useNativeSearchForModel,
            forceRefresh,
            cachePolicy,
            onRetryProgress: (retryProgress) => {
              dispatchTurnAction('UPDATE_ROUND_STREAM', {
                roundIndex,
                streamIndex: si,
                status: 'streaming',
                error: null,
                errorKind: null,
                retryProgress,
                routeInfo,
              });
            },
            onChunk: (_delta, accumulated) => {
              dispatchTurnAction('UPDATE_ROUND_STREAM', {
                roundIndex,
                streamIndex: si,
                content: accumulated,
                status: 'streaming',
                error: null,
                errorKind: null,
                routeInfo,
              });
            },
            onReasoning: (accumulatedReasoning) => {
              dispatchTurnAction('UPDATE_ROUND_STREAM', {
                roundIndex,
                streamIndex: si,
                status: 'streaming',
                error: null,
                errorKind: null,
                reasoning: accumulatedReasoning,
                routeInfo,
              });
            },
          });
          const searchEvidence = roundIndex === 0 && Boolean(lastTurn.webSearchEnabled)
            ? buildSearchEvidence({
              prompt: userPrompt,
              content,
              searchMetadata,
              strictMode: strictWebSearch,
              mode: webSearchCtx ? 'legacy_context' : (useNativeSearchForModel ? 'native' : 'native_skipped'),
              fallbackApplied: Boolean(webSearchCtx && nativeSearchStrategy.fallbackReason),
              fallbackReason: webSearchCtx ? nativeSearchStrategy.fallbackReason : null,
            })
            : undefined;
          if (roundIndex === 0 && Boolean(lastTurn.webSearchEnabled) && strictWebSearch && searchEvidence && !searchEvidence.verified) {
            const message = searchEvidence.primaryIssue
              ? `Strict web-search mode blocked this response: ${searchEvidence.primaryIssue}`
              : 'Strict web-search mode blocked this response: unable to verify web evidence.';
            const blockedEvidence = {
              ...searchEvidence,
              strictBlocked: true,
              strictError: message,
            };
            const fallbackState = replacementModel
              ? null
              : buildPreviousResponseFallback(previousStream, {
                model,
                error: message,
                errorKind: 'strict_blocked',
                searchEvidence: blockedEvidence,
                routeInfo,
              });
            dispatchTurnAction('UPDATE_ROUND_STREAM', fallbackState
              ? {
                roundIndex,
                streamIndex: si,
                ...fallbackState,
                model,
              }
              : {
                roundIndex,
                streamIndex: si,
                model,
                content: '',
                status: 'error',
                error: message,
                errorKind: 'strict_blocked',
                outcome: null,
                usage,
                durationMs,
                reasoning: reasoning || null,
                searchEvidence: blockedEvidence,
                retryProgress: null,
                cacheHit: Boolean(fromCache),
                routeInfo,
              });
            return {
              model,
              content: fallbackState?.content || '',
              index: si,
              error: fallbackState ? null : message,
              errorKind: fallbackState ? null : 'strict_blocked',
              outcome: fallbackState?.outcome || null,
              searchEvidence: blockedEvidence,
              routeInfo,
              effectiveModel,
              fromCache: Boolean(fromCache),
            };
          }
          dispatchTurnAction('UPDATE_ROUND_STREAM', {
            roundIndex,
            streamIndex: si,
            model,
            content,
            status: 'complete',
            error: null,
            errorKind: null,
            outcome: 'success',
            usage,
            durationMs,
            completedAt: Date.now(),
            reasoning: reasoning || null,
            searchEvidence,
            retryProgress: null,
            cacheHit: Boolean(fromCache),
            routeInfo,
          });
          return {
            model,
            content,
            index: si,
            searchEvidence,
            routeInfo,
            effectiveModel,
            fromCache: Boolean(fromCache),
          };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          const errorMsg = err.message || 'An error occurred';
          const diagnostic = routeInfo?.reason && !routeInfo?.routed
            ? `${errorMsg} (${routeInfo.reason})`
            : errorMsg;
          const fallbackState = replacementModel
            ? null
            : buildPreviousResponseFallback(previousStream, {
              model,
              error: `Retry failed - showing previous response. ${diagnostic}`.trim(),
              errorKind: 'failed',
              routeInfo,
            });
          dispatchTurnAction('UPDATE_ROUND_STREAM', fallbackState
            ? {
              roundIndex,
              streamIndex: si,
              ...fallbackState,
              model,
            }
            : {
              roundIndex,
              streamIndex: si,
              model,
              content: '',
              status: 'error',
              error: diagnostic,
              errorKind: 'failed',
              outcome: null,
              retryProgress: null,
              routeInfo,
            });
          return {
            model,
            content: fallbackState?.content || '',
            index: si,
            error: fallbackState ? null : diagnostic,
            errorKind: fallbackState ? null : 'failed',
            outcome: fallbackState?.outcome || null,
            routeInfo,
            effectiveModel,
          };
        }
      })
    );

    if (abortController.signal.aborted) {
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // Build lastCompletedStreams: existing complete streams + retry results
    let lastCompletedStreams = [];
    for (let i = 0; i < models.length; i++) {
      if (!failedIndices.includes(i)) {
        // Kept from existing complete stream
        const s = targetRound.streams[i];
        if (s.content && s.status === 'complete') {
          lastCompletedStreams.push({ model: s.model, content: s.content, status: 'complete' });
        }
      } else {
        // From retry results
        const retryIdx = failedIndices.indexOf(i);
        const result = retryResults[retryIdx];
        if (result.status === 'fulfilled' && result.value.content && !result.value.error) {
          lastCompletedStreams.push({ model: result.value.model, content: result.value.content, status: 'complete' });
        }
      }
    }

    if (lastCompletedStreams.length === 0) {
      dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'error' });
      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: lastTurn.synthesis?.content || '',
        status: 'error',
        error: 'All models failed. Cannot synthesize.',
        retryProgress: null,
      });
      dispatchTurnAction('SET_DEBATE_METADATA', {
        metadata: { totalRounds: roundIndex + 1, converged: false, terminationReason: 'all_models_failed' },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex, status: 'complete' });

    // Continue debate from this round: convergence check + more rounds + synthesis
    let converged = false;
    let terminationReason = null;
    let totalRounds = roundIndex + 1;
    let currentRoundIndex = roundIndex;
    const synthesisRounds = toSynthesisRounds(lastTurn.rounds, roundIndex);
    let currentRoundConvergence = targetRound.convergenceCheck || null;

    // Convergence check on current round
    if (shouldRunConvergenceCheck(totalRounds, maxRounds, runConvergenceOnFinalRound) && !abortController.signal.aborted) {
      dispatchTurnAction('SET_CONVERGENCE', {
        roundIndex: currentRoundIndex,
        convergenceCheck: { converged: null, reason: 'Checking...' },
      });
      try {
        const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: totalRounds });
        const { content: cResponse, usage: cUsage } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
        const parsed = parseConvergenceResponse(cResponse);
        parsed.rawResponse = cResponse;
        parsed.usage = cUsage || null;
        currentRoundConvergence = parsed;
        dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: parsed });
        if (parsed.converged) { converged = true; terminationReason = 'converged'; }
      } catch (err) {
        if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }
        currentRoundConvergence = { converged: false, reason: 'Convergence check failed: ' + err.message };
        dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: currentRoundConvergence });
      }
    }

    const currentRoundSummary = buildSynthesisRoundSummary({
      label: targetRound.label || getRoundLabel(roundIndex + 1),
      roundNumber: roundIndex + 1,
      streams: lastCompletedStreams,
      convergenceCheck: currentRoundConvergence,
    });
    if (currentRoundSummary) {
      synthesisRounds.push(currentRoundSummary);
    }

    // Continue with additional rounds if not converged
    if (!converged && !abortController.signal.aborted && totalRounds < maxRounds) {
      for (let roundNum = totalRounds + 1; roundNum <= maxRounds; roundNum++) {
        if (abortController.signal.aborted) break;
        const roundLabel = getRoundLabel(roundNum);
        const round = createRound({ roundNumber: roundNum, label: roundLabel, models });
        currentRoundIndex = roundNum - 1;
        let roundConvergence = null;
        dispatchTurnAction('ADD_ROUND', { round });
        dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: currentRoundIndex, status: 'streaming' });
        const messagesPerModel = models.map(() =>
          buildRebuttalMessages({
            userPrompt,
            previousRoundStreams: lastCompletedStreams,
            roundNumber: roundNum,
            conversationHistory,
            focused: turnFocused,
            webSearchContext: webSearchCtx,
            webSearchModel: fallbackSearchModel,
          })
        );
        const roundSearchVerification = Boolean(lastTurn.webSearchEnabled)
          ? {
            enabled: true,
            prompt: userPrompt,
            strictMode: false,
            mode: hasLaterRoundSearchRefresh ? 'refresh_context' : (webSearchCtx ? 'legacy_context' : 'debate_rebuttal'),
          }
          : null;
        const results = await runRound({
          models,
          messagesPerModel,
          convId,
          turnId,
          runId,
          roundIndex: currentRoundIndex,
          apiKey,
          signal: abortController.signal,
          searchVerification: roundSearchVerification,
          forceRefresh,
        });
        if (abortController.signal.aborted) { terminationReason = 'cancelled'; break; }
        const completedStreams = results.filter(r => r.content && !r.error);
        if (completedStreams.length === 0) {
          dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: currentRoundIndex, status: 'error' });
          terminationReason = 'all_models_failed'; totalRounds = roundNum; break;
        }
        if (completedStreams.length < models.length) {
          for (const result of results) {
            if (result.error && !result.content) {
              const prev = lastCompletedStreams.find(s => s.model === result.model);
              if (prev) {
                result.content = prev.content;
                dispatchTurnAction('UPDATE_ROUND_STREAM', {
                  roundIndex: currentRoundIndex,
                  streamIndex: result.index,
                  content: prev.content,
                  status: 'complete',
                  error: 'Failed this round - showing previous response',
                  errorKind: result.errorKind || 'failed',
                  outcome: 'using_previous_response',
                  retryProgress: null,
                });
              }
            }
          }
        }
        lastCompletedStreams = results.filter(r => r.content).map(r => ({ model: r.model, content: r.content, status: 'complete' }));
        dispatchTurnAction('UPDATE_ROUND_STATUS', { roundIndex: currentRoundIndex, status: 'complete' });
        totalRounds = roundNum;
        if (shouldRunConvergenceCheck(roundNum, maxRounds, runConvergenceOnFinalRound)) {
          if (abortController.signal.aborted) break;
          dispatchTurnAction('SET_CONVERGENCE', {
            roundIndex: currentRoundIndex,
            convergenceCheck: { converged: null, reason: 'Checking...' },
          });
          try {
            const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: roundNum });
            const { content: cResponse, usage: cUsage } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
            const parsed = parseConvergenceResponse(cResponse);
            parsed.rawResponse = cResponse;
            parsed.usage = cUsage || null;
            roundConvergence = parsed;
            dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: parsed });
            if (parsed.converged) {
              converged = true;
              terminationReason = 'converged';
              const convergedRoundSummary = buildSynthesisRoundSummary({
                label: roundLabel,
                roundNumber: roundNum,
                streams: lastCompletedStreams,
                convergenceCheck: roundConvergence,
              });
              if (convergedRoundSummary) {
                synthesisRounds.push(convergedRoundSummary);
              }
              break;
            }
          } catch (err) {
            if (abortController.signal.aborted) break;
            roundConvergence = { converged: false, reason: 'Convergence check failed: ' + err.message };
            dispatchTurnAction('SET_CONVERGENCE', { roundIndex: currentRoundIndex, convergenceCheck: roundConvergence });
          }
        }
        const refreshDecision = getLaterRoundSearchRefreshDecision({
          roundNum,
          maxRounds,
          webSearchEnabled: Boolean(lastTurn.webSearchEnabled),
          canUseLegacySearchFallback: canUseLaterRoundSearchFallback,
          refreshesUsed: laterRoundSearchRefreshesUsed,
          results,
          convergenceCheck: roundConvergence,
        });
        if (refreshDecision.shouldRefresh) {
          laterRoundSearchRefreshesUsed += 1;
          hasLaterRoundSearchRefresh = true;
          const refreshedContext = await runLegacyWebSearch({
            convId,
            turnId,
            runId,
            userPrompt,
            attachments,
            videoUrls: lastTurn.routeInfo?.youtubeUrls || [],
            webSearchModel: fallbackSearchModel,
            apiKey,
            signal: abortController.signal,
          });
          if (abortController.signal.aborted) { terminationReason = 'cancelled'; break; }
          if (refreshedContext) {
            webSearchCtx = refreshedContext;
          }
        }
        const roundSummary = buildSynthesisRoundSummary({
          label: roundLabel,
          roundNumber: roundNum,
          streams: lastCompletedStreams,
          convergenceCheck: roundConvergence,
        });
        if (roundSummary) {
          synthesisRounds.push(roundSummary);
        }
        if (roundNum === maxRounds && !converged) terminationReason = 'max_rounds_reached';
      }
    } else if (totalRounds >= maxRounds) {
      terminationReason = terminationReason || 'max_rounds_reached';
    }

    if (abortController.signal.aborted) {
      dispatchTurnAction('SET_DEBATE_METADATA', {
        metadata: { totalRounds, converged: false, terminationReason: 'cancelled' },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatchTurnAction('SET_DEBATE_METADATA', {
      metadata: { totalRounds, converged, terminationReason: terminationReason || 'max_rounds_reached' },
    });

    // Synthesis
    if (!lastCompletedStreams || lastCompletedStreams.length === 0) {
      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: lastTurn.synthesis?.content || '',
        status: 'error',
        error: 'All models failed. Cannot synthesize.',
        retryProgress: null,
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatchTurnAction('UPDATE_SYNTHESIS', {
      model: synthModel,
      content: lastTurn.synthesis?.content || '',
      status: 'streaming',
      error: null,
      retryProgress: null,
    });
    const finalRoundSummary = {
      label: `Final positions after ${totalRounds} round(s)`,
      streams: lastCompletedStreams,
      convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null,
    };
    const roundsForSynthesis = synthesisRounds.length > 0
      ? [...synthesisRounds, finalRoundSummary]
      : [finalRoundSummary];

    const synthesisMessages = buildMultiRoundSynthesisMessages({
      userPrompt,
      rounds: roundsForSynthesis,
      conversationHistory,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await runStreamWithFallback({
        model: synthModel, messages: synthesisMessages, apiKey, signal: abortController.signal,
        forceRefresh,
        onRetryProgress: (retryProgress) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: lastTurn.synthesis?.content || '',
            status: 'streaming',
            error: null,
            retryProgress,
          });
        },
        onChunk: (_delta, accumulated) => {
          dispatchTurnAction('UPDATE_SYNTHESIS', {
            model: synthModel,
            content: accumulated,
            status: 'streaming',
            error: null,
          });
        },
      });
      dispatchTurnAction('UPDATE_SYNTHESIS', {
        model: synthModel,
        content: synthesisContent,
        status: 'complete',
        error: null,
        usage: synthesisUsage,
        durationMs: synthesisDurationMs,
        retryProgress: null,
      });
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatchTurnAction('UPDATE_SYNTHESIS', {
          model: synthModel,
          content: lastTurn.synthesis?.content || '',
          status: 'error',
          error: err.message,
          retryProgress: null,
        });
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [activeConversation, state.apiKey, state.synthesizerModel, state.convergenceModel, state.convergenceOnFinalRound, state.maxDebateRounds, state.focusedMode, state.webSearchModel, state.strictWebSearch, state.modelCatalog, state.capabilityRegistry, buildNativeWebSearchStrategy, setAbortController]);

  const retryAllFailed = useCallback((options = {}) => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    const rounds = Array.isArray(lastTurn.rounds) ? lastTurn.rounds : [];
    if (rounds.length === 0) return;

    const firstFailedRoundIndex = rounds.findIndex((round) =>
      deriveRoundStatusFromStreams(round?.streams || [], round?.status || 'pending') === 'warning'
      || deriveRoundStatusFromStreams(round?.streams || [], round?.status || 'pending') === 'error'
    );

    if (firstFailedRoundIndex < 0) return;
    retryRound(firstFailedRoundIndex, {
      forceRefresh: Boolean(options.forceRefresh),
      retryErroredCompleted: true,
    });
  }, [activeConversation, retryRound]);

  const retryWebSearch = useCallback((options = {}) => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const forceRefresh = Boolean(options.forceRefresh);
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    if (!lastTurn.webSearchEnabled || !lastTurn.webSearchResult) return;
    if (!Array.isArray(lastTurn.rounds) || lastTurn.rounds.length === 0) return;
    if (lastTurn.mode === 'parallel') {
      retryLastTurn({ forceRefresh, forceLegacyWebSearch: true });
      return;
    }
    retryRound(0, {
      forceRefresh,
      retryErroredCompleted: true,
      redoRound: true,
      forceLegacyWebSearch: true,
    });
  }, [activeConversation, retryLastTurn, retryRound]);

  const retryStream = useCallback((roundIndex, streamIndex, options = {}) => {
    const replacementModel = typeof options.replacementModel === 'string' && options.replacementModel
      ? options.replacementModel
      : null;
    retryRound(roundIndex, {
      ...options,
      forceRefresh: Boolean(options.forceRefresh),
      retryErroredCompleted: true,
      streamIndices: [streamIndex],
      replacementModels: replacementModel ? { [streamIndex]: replacementModel } : undefined,
    });
  }, [retryRound]);

  const suggestReplacementModel = useCallback((roundIndex, streamIndex) => {
    if (!activeConversation || activeConversation.turns.length === 0) return null;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    const round = Array.isArray(lastTurn.rounds) ? lastTurn.rounds[roundIndex] : null;
    const stream = round?.streams?.[streamIndex];
    if (!stream?.model) return null;

    return selectReplacementModel({
      currentModel: stream.model,
      roundModels: (round.streams || []).map((item) => item.model),
      modelCatalog: state.modelCatalog,
      metrics: state.metrics,
      rankingMode: state.smartRankingMode,
      rankingPreferences: {
        preferFlagship: state.smartRankingPreferFlagship,
        preferNew: state.smartRankingPreferNew,
        allowPreview: state.smartRankingAllowPreview,
      },
    });
  }, [
    activeConversation,
    state.modelCatalog,
    state.metrics,
    state.smartRankingMode,
    state.smartRankingPreferFlagship,
    state.smartRankingPreferNew,
    state.smartRankingAllowPreview,
  ]);

  const replaceStreamModel = useCallback((roundIndex, streamIndex, options = {}) => {
    const replacementModel = options.replacementModel || suggestReplacementModel(roundIndex, streamIndex);
    if (!replacementModel) return;
    retryStream(roundIndex, streamIndex, {
      ...options,
      replacementModel,
    });
  }, [retryStream, suggestReplacementModel]);

  const settingsValue = useMemo(() => ({
    apiKey: state.apiKey,
    rememberApiKey: state.rememberApiKey,
    selectedModels: state.selectedModels,
    synthesizerModel: state.synthesizerModel,
    convergenceModel: state.convergenceModel,
    convergenceOnFinalRound: state.convergenceOnFinalRound,
    maxDebateRounds: state.maxDebateRounds,
    webSearchModel: state.webSearchModel,
    strictWebSearch: state.strictWebSearch,
    retryPolicy: state.retryPolicy,
    budgetGuardrailsEnabled: state.budgetGuardrailsEnabled,
    budgetSoftLimitUsd: state.budgetSoftLimitUsd,
    budgetAutoApproveBelowUsd: state.budgetAutoApproveBelowUsd,
    smartRankingMode: state.smartRankingMode,
    smartRankingPreferFlagship: state.smartRankingPreferFlagship,
    smartRankingPreferNew: state.smartRankingPreferNew,
    smartRankingAllowPreview: state.smartRankingAllowPreview,
    streamVirtualizationEnabled: state.streamVirtualizationEnabled,
    streamVirtualizationKeepLatest: state.streamVirtualizationKeepLatest,
    cachePersistenceEnabled: state.cachePersistenceEnabled,
    themeMode: state.themeMode,
    cacheHitCount: state.cacheHitCount,
    cacheEntryCount: state.cacheEntryCount,
    modelPresets: state.modelPresets,
    modelCatalog: state.modelCatalog,
    modelCatalogStatus: state.modelCatalogStatus,
    modelCatalogError: state.modelCatalogError,
    providerStatus: state.providerStatus,
    capabilityRegistry: state.capabilityRegistry,
    providerStatusState: state.providerStatusState,
    providerStatusError: state.providerStatusError,
    metrics: state.metrics,
  }), [
    state.apiKey,
    state.rememberApiKey,
    state.selectedModels,
    state.synthesizerModel,
    state.convergenceModel,
    state.convergenceOnFinalRound,
    state.maxDebateRounds,
    state.webSearchModel,
    state.strictWebSearch,
    state.retryPolicy,
    state.budgetGuardrailsEnabled,
    state.budgetSoftLimitUsd,
    state.budgetAutoApproveBelowUsd,
    state.smartRankingMode,
    state.smartRankingPreferFlagship,
    state.smartRankingPreferNew,
    state.smartRankingAllowPreview,
    state.streamVirtualizationEnabled,
    state.streamVirtualizationKeepLatest,
    state.cachePersistenceEnabled,
    state.themeMode,
    state.cacheHitCount,
    state.cacheEntryCount,
    state.modelPresets,
    state.modelCatalog,
    state.modelCatalogStatus,
    state.modelCatalogError,
    state.providerStatus,
    state.capabilityRegistry,
    state.providerStatusState,
    state.providerStatusError,
    state.metrics,
  ]);

  const uiValue = useMemo(() => ({
    showSettings: state.showSettings,
    editingTurn: state.editingTurn,
    webSearchEnabled: state.webSearchEnabled,
    chatMode: state.chatMode,
    focusedMode: state.focusedMode,
  }), [
    state.showSettings,
    state.editingTurn,
    state.webSearchEnabled,
    state.chatMode,
    state.focusedMode,
  ]);

  const conversationList = useMemo(
    () => state.conversations.map((conversation) => buildConversationListItem(conversation)),
    [state.conversations],
  );
  const getConversationById = useCallback(
    (conversationId) => state.conversations.find((conversation) => conversation.id === conversationId) || null,
    [state.conversations],
  );
  const getConversationsSnapshot = useCallback(
    () => state.conversations.slice(),
    [state.conversations],
  );

  const conversationValue = useMemo(() => ({
    activeConversationId: state.activeConversationId,
    activeConversation,
    debateInProgress: activeConversationInProgress,
    activeConversationInProgress,
  }), [
    state.activeConversationId,
    activeConversation,
    activeConversationInProgress,
  ]);

  const conversationListValue = useMemo(() => ({
    conversations: conversationList,
    activeConversationId: state.activeConversationId,
    isConversationInProgress,
    getConversationById,
    getConversationsSnapshot,
  }), [
    conversationList,
    state.activeConversationId,
    isConversationInProgress,
    getConversationById,
    getConversationsSnapshot,
  ]);

  const actionValue = useMemo(() => ({
    dispatch,
    startDebate,
    startDirect,
    startParallel,
    cancelDebate,
    editLastTurn,
    retryLastTurn,
    retryAllFailed,
    retryWebSearch,
    retryStream,
    replaceStreamModel,
    suggestReplacementModel,
    retryRound,
    retrySynthesis,
    branchFromRound,
    clearResponseCache,
    resetDiagnostics,
  }), [
    dispatch,
    startDebate,
    startDirect,
    startParallel,
    cancelDebate,
    editLastTurn,
    retryLastTurn,
    retryAllFailed,
    retryWebSearch,
    retryStream,
    replaceStreamModel,
    suggestReplacementModel,
    retryRound,
    retrySynthesis,
    branchFromRound,
    clearResponseCache,
    resetDiagnostics,
  ]);

  return (
    <DebateActionContext.Provider value={actionValue}>
      <DebateSettingsContext.Provider value={settingsValue}>
        <DebateUiContext.Provider value={uiValue}>
          <DebateConversationListContext.Provider value={conversationListValue}>
            <DebateConversationContext.Provider value={conversationValue}>
              {children}
            </DebateConversationContext.Provider>
          </DebateConversationListContext.Provider>
        </DebateUiContext.Provider>
      </DebateSettingsContext.Provider>
    </DebateActionContext.Provider>
  );
}

function useRequiredContext(context, name) {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${name} must be used within a DebateProvider`);
  }
  return value;
}

export function useDebateActions() {
  return useRequiredContext(DebateActionContext, 'useDebateActions');
}

export function useDebateSettings() {
  return useRequiredContext(DebateSettingsContext, 'useDebateSettings');
}

export function useDebateUi() {
  return useRequiredContext(DebateUiContext, 'useDebateUi');
}

export function useDebateConversations() {
  return useRequiredContext(DebateConversationContext, 'useDebateConversations');
}

export function useDebateConversationList() {
  return useRequiredContext(DebateConversationListContext, 'useDebateConversationList');
}

export function useDebate() {
  return {
    ...useDebateSettings(),
    ...useDebateUi(),
    ...useDebateConversationList(),
    ...useDebateConversations(),
    ...useDebateActions(),
  };
}

