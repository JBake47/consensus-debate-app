import { createContext, useContext, useReducer, useCallback, useRef, useEffect } from 'react';
import {
  streamChat,
  chatCompletion,
  fetchModels,
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
import { buildAttachmentContent, buildAttachmentTextContent } from '../lib/fileProcessor';
import {
  buildConversationContext,
  buildSummaryPrompt,
} from '../lib/contextManager';
import { generateTitle } from '../lib/titleGenerator';

const DebateContext = createContext(null);

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

function migrateConversations(conversations) {
  let migrated = false;
  const result = conversations.map(conv => {
    const turns = conv.turns.map(turn => {
      if (!turn.rounds && turn.streams) {
        migrated = true;
        return migrateTurn(turn);
      }
      return turn;
    });
    // Migrate updatedAt for existing conversations
    let updatedAt = conv.updatedAt;
    if (!updatedAt) {
      migrated = true;
      updatedAt = conv.createdAt || Date.now();
    }
    return { ...conv, turns, updatedAt };
  });
  return { conversations: result, migrated };
}

const rawConversations = loadFromStorage('debate_conversations', []);
const { conversations: migratedConversations, migrated } = migrateConversations(rawConversations);
if (migrated) {
  saveToStorage('debate_conversations', migratedConversations);
}

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
  maxDebateRounds: loadFromStorage('max_debate_rounds', DEFAULT_MAX_DEBATE_ROUNDS),
  webSearchModel: loadFromStorage('web_search_model', DEFAULT_WEB_SEARCH_MODEL),
  chatMode: loadFromStorage('chat_mode', 'debate'),
  focusedMode: loadFromStorage('focused_mode', false),
  webSearchEnabled: false,
  modelCatalog: {},
  modelCatalogStatus: 'idle',
  modelCatalogError: null,
  conversations: migratedConversations,
  activeConversationId: null,
  debateInProgress: false,
  showSettings: false,
  editingTurn: null,
};

function updateLastTurn(conversations, conversationId, updater) {
  return conversations.map(c => {
    if (c.id !== conversationId) return c;
    const turns = [...c.turns];
    const lastTurn = { ...turns[turns.length - 1] };
    updater(lastTurn);
    turns[turns.length - 1] = lastTurn;
    return { ...c, turns };
  });
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
    case 'SET_SYNTHESIZER': {
      saveToStorage('synthesizer_model', action.payload);
      return { ...state, synthesizerModel: action.payload };
    }
    case 'SET_CONVERGENCE_MODEL': {
      saveToStorage('convergence_model', action.payload);
      return { ...state, convergenceModel: action.payload };
    }
    case 'SET_MAX_DEBATE_ROUNDS': {
      saveToStorage('max_debate_rounds', action.payload);
      return { ...state, maxDebateRounds: action.payload };
    }
    case 'SET_WEB_SEARCH_MODEL': {
      saveToStorage('web_search_model', action.payload);
      return { ...state, webSearchModel: action.payload };
    }
    case 'SET_WEB_SEARCH_ENABLED': {
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
      const { conversationId, result } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.webSearchResult = result;
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
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
    case 'SET_ACTIVE_CONVERSATION': {
      return { ...state, activeConversationId: action.payload };
    }
    case 'NEW_CONVERSATION': {
      const conv = {
        id: action.payload.id,
        title: action.payload.title || 'New Debate',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: [],
      };
      const conversations = [conv, ...state.conversations];
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations, activeConversationId: conv.id };
    }
    case 'ADD_TURN': {
      const convId = action.payload.conversationId || state.activeConversationId;
      const conversations = state.conversations.map(c =>
        c.id === convId
          ? { ...c, turns: [...c.turns, action.payload.turn], updatedAt: Date.now() }
          : c
      );
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'ADD_ROUND': {
      const { conversationId, round } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.rounds = [...(lastTurn.rounds || []), round];
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'UPDATE_ROUND_STREAM': {
      const { conversationId, roundIndex, streamIndex, content, status, error, usage, durationMs, reasoning } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const rounds = [...lastTurn.rounds];
        const round = { ...rounds[roundIndex] };
        const streams = [...round.streams];
        const updates = { ...streams[streamIndex], status, error };
        if (content !== undefined) updates.content = content;
        if (usage !== undefined) updates.usage = usage;
        if (durationMs !== undefined) updates.durationMs = durationMs;
        if (reasoning !== undefined) updates.reasoning = reasoning;
        streams[streamIndex] = updates;
        round.streams = streams;
        rounds[roundIndex] = round;
        lastTurn.rounds = rounds;
      });
      if (status === 'complete' || status === 'error') {
        saveToStorage('debate_conversations', conversations);
      }
      return { ...state, conversations };
    }
    case 'UPDATE_ROUND_STATUS': {
      const { conversationId, roundIndex, status } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const rounds = [...lastTurn.rounds];
        rounds[roundIndex] = { ...rounds[roundIndex], status };
        lastTurn.rounds = rounds;
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'SET_CONVERGENCE': {
      const { conversationId, roundIndex, convergenceCheck } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const rounds = [...lastTurn.rounds];
        rounds[roundIndex] = { ...rounds[roundIndex], convergenceCheck };
        lastTurn.rounds = rounds;
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'SET_DEBATE_METADATA': {
      const { conversationId, metadata } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.debateMetadata = metadata;
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'SET_ENSEMBLE_RESULT': {
      const { conversationId, ensembleResult } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.ensembleResult = ensembleResult;
      });
      const shouldPersist = ensembleResult.status === 'complete' || ensembleResult.status === 'error';
      if (shouldPersist) {
        saveToStorage('debate_conversations', conversations);
      }
      return { ...state, conversations };
    }
    case 'SET_RUNNING_SUMMARY': {
      const { conversationId, summary } = action.payload;
      const conversations = state.conversations.map(c =>
        c.id === conversationId ? { ...c, runningSummary: summary } : c
      );
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'UPDATE_SYNTHESIS': {
      const { conversationId, content, status, error, model, usage, durationMs } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        const completedAt = status === 'complete' ? Date.now() : (lastTurn.synthesis?.completedAt || null);
        const synth = { model, content, status, error, completedAt };
        if (usage !== undefined) synth.usage = usage;
        if (durationMs !== undefined) synth.durationMs = durationMs;
        lastTurn.synthesis = synth;
      });
      if (status === 'complete' || status === 'error') {
        saveToStorage('debate_conversations', conversations);
      }
      return { ...state, conversations };
    }
    case 'SET_CONVERSATION_TITLE': {
      const { conversationId, title } = action.payload;
      const conversations = state.conversations.map(c =>
        c.id === conversationId ? { ...c, title } : c
      );
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'SET_CONVERSATION_DESCRIPTION': {
      const { conversationId, description } = action.payload;
      const conversations = state.conversations.map(c =>
        c.id === conversationId ? { ...c, description } : c
      );
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'DELETE_CONVERSATION': {
      const conversations = state.conversations.filter(c => c.id !== action.payload);
      saveToStorage('debate_conversations', conversations);
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
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
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
        return { ...c, turns, updatedAt: Date.now() };
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'TRUNCATE_ROUNDS': {
      const { conversationId, keepCount } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.rounds = lastTurn.rounds.slice(0, keepCount);
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    case 'RESET_SYNTHESIS': {
      const { conversationId, model } = action.payload;
      const conversations = updateLastTurn(state.conversations, conversationId, (lastTurn) => {
        lastTurn.synthesis = { model, content: '', status: 'pending', error: null };
      });
      saveToStorage('debate_conversations', conversations);
      return { ...state, conversations };
    }
    default:
      return state;
  }
}

export function DebateProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const abortControllerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    dispatch({ type: 'SET_MODEL_CATALOG_STATUS', payload: { status: 'loading', error: null } });

    fetchModels()
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

  const activeConversation = state.conversations.find(
    c => c.id === state.activeConversationId
  );

  /**
   * Run one round of streaming from all models in parallel.
   * Returns an array of { model, content, index, error? } results.
   */
  const runRound = async ({ models, messages, messagesPerModel, convId, roundIndex, apiKey, signal }) => {
    const streamResults = await Promise.allSettled(
      models.map(async (model, index) => {
        dispatch({
          type: 'UPDATE_ROUND_STREAM',
          payload: {
            conversationId: convId,
            roundIndex,
            streamIndex: index,
            content: '',
            status: 'streaming',
            error: null,
          },
        });

        const modelMessages = messagesPerModel ? messagesPerModel[index] : messages;

        try {
          const { content, reasoning, usage, durationMs } = await streamChat({
            model,
            messages: modelMessages,
            apiKey,
            signal,
            onChunk: (_delta, accumulated) => {
              dispatch({
                type: 'UPDATE_ROUND_STREAM',
                payload: {
                  conversationId: convId,
                  roundIndex,
                  streamIndex: index,
                  content: accumulated,
                  status: 'streaming',
                  error: null,
                },
              });
            },
            onReasoning: (accumulatedReasoning) => {
              dispatch({
                type: 'UPDATE_ROUND_STREAM',
                payload: {
                  conversationId: convId,
                  roundIndex,
                  streamIndex: index,
                  status: 'streaming',
                  error: null,
                  reasoning: accumulatedReasoning,
                },
              });
            },
          });

          dispatch({
            type: 'UPDATE_ROUND_STREAM',
            payload: {
              conversationId: convId,
              roundIndex,
              streamIndex: index,
              content,
              status: 'complete',
              error: null,
              usage,
              durationMs,
              reasoning: reasoning || null,
            },
          });

          return { model, content, index };
        } catch (err) {
          if (err.name === 'AbortError') {
            dispatch({
              type: 'UPDATE_ROUND_STREAM',
              payload: {
                conversationId: convId,
                roundIndex,
                streamIndex: index,
                content: '',
                status: 'error',
                error: 'Cancelled',
              },
            });
            return { model, content: '', index, error: 'Cancelled' };
          }
          const errorMsg = err.message || 'An error occurred';
          dispatch({
            type: 'UPDATE_ROUND_STREAM',
            payload: {
              conversationId: convId,
              roundIndex,
              streamIndex: index,
              content: '',
              status: 'error',
              error: errorMsg,
            },
          });
          return { model, content: '', index, error: errorMsg };
        }
      })
    );

    return streamResults.map(r =>
      r.status === 'fulfilled' ? r.value : { model: null, content: '', error: 'Aborted' }
    );
  };

  const startDebate = useCallback(async (userPrompt, { webSearch = false, attachments } = {}) => {
    const models = state.selectedModels;
    const synthModel = state.synthesizerModel;
    const convergenceModel = state.convergenceModel;
    const maxRounds = state.maxDebateRounds;
    const webSearchModel = state.webSearchModel;
    const apiKey = state.apiKey;
    const focused = state.focusedMode;

    // Create new conversation if none active
    let convId = state.activeConversationId;
    if (!convId) {
      convId = Date.now().toString();
      const title = userPrompt.length > 50
        ? userPrompt.slice(0, 50) + '...'
        : userPrompt;
      dispatch({ type: 'NEW_CONVERSATION', payload: { id: convId, title } });
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });

    // Build new turn with rounds structure
    const turn = {
      id: Date.now().toString(),
      userPrompt,
      timestamp: Date.now(),
      attachments: attachments || null,
      mode: 'debate',
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

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // ===== WEB SEARCH (optional) =====
    let webSearchContext = '';
    if (webSearch && webSearchModel) {
      dispatch({
        type: 'SET_WEB_SEARCH_RESULT',
        payload: {
          conversationId: convId,
          result: { status: 'searching', content: '', model: webSearchModel, error: null },
        },
      });

      try {
        const searchPrompt = buildAttachmentTextContent(userPrompt, attachments);
        const { content: searchContent, durationMs: searchDurationMs } = await chatCompletion({
          model: webSearchModel,
          messages: [
            {
              role: 'system',
              content: 'Search the web to find current, accurate information relevant to the user\'s query. Provide a comprehensive summary of what you find, including key facts, data, and sources.',
            },
            { role: 'user', content: searchPrompt },
          ],
          apiKey,
          signal: abortController.signal,
        });

        webSearchContext = searchContent;
        dispatch({
          type: 'SET_WEB_SEARCH_RESULT',
          payload: {
            conversationId: convId,
            result: { status: 'complete', content: searchContent, model: webSearchModel, error: null, durationMs: searchDurationMs },
          },
        });
      } catch (err) {
        if (abortController.signal.aborted) {
          dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
          return;
        }
        dispatch({
          type: 'SET_WEB_SEARCH_RESULT',
          payload: {
            conversationId: convId,
            result: { status: 'error', content: '', model: webSearchModel, error: err.message },
          },
        });
        // Continue without search results
      }
    }

    // Build rich conversation context with smart management
    const currentConv = state.conversations.find(c => c.id === convId);
    const { messages: contextMessages, needsSummary, turnsToSummarize } = buildConversationContext({
      conversation: currentConv,
      runningSummary: currentConv?.runningSummary || null,
    });

    // If context is too large, summarize older turns in the background
    if (needsSummary && currentConv && turnsToSummarize > 0) {
      const turnsForSummary = currentConv.turns.slice(0, turnsToSummarize);
      const summaryMessages = buildSummaryPrompt({
        existingSummary: currentConv.runningSummary || null,
        turnsToSummarize: turnsForSummary,
      });
      // Fire and forget — don't block the debate
      chatCompletion({
        model: state.synthesizerModel,
        messages: summaryMessages,
        apiKey,
        signal: abortController.signal,
      }).then(({ content: summary }) => {
        dispatch({
          type: 'SET_RUNNING_SUMMARY',
          payload: { conversationId: convId, summary },
        });
      }).catch(() => {
        // Summarization failed — not critical, continue without it
      });
    }

    // If web search returned results, prepend them as context
    const userMessageContent = webSearchContext
      ? `${userPrompt}\n\n---\n**Web Search Context (from ${webSearchModel}):**\n${webSearchContext}`
      : userPrompt;

    // conversationHistory for rebuttal/synthesis builders (just the context messages)
    const conversationHistory = contextMessages;

    // Build user message content with attachments (text inline, images as multimodal parts)
    const userContent = buildAttachmentContent(userMessageContent, attachments);
    const initialMessages = [...conversationHistory, { role: 'user', content: userContent }];

    let lastCompletedStreams = null;
    let converged = false;
    let terminationReason = null;
    let totalRounds = 0;

    // ===== MULTI-ROUND DEBATE LOOP =====
    for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
      if (abortController.signal.aborted) break;

      const roundLabel = getRoundLabel(roundNum);
      const round = createRound({ roundNumber: roundNum, label: roundLabel, models });
      const roundIndex = roundNum - 1;

      dispatch({ type: 'ADD_ROUND', payload: { conversationId: convId, round } });
      dispatch({
        type: 'UPDATE_ROUND_STATUS',
        payload: { conversationId: convId, roundIndex, status: 'streaming' },
      });

      let roundMessages;
      let messagesPerModel = null;

      if (roundNum === 1) {
        // Round 1: all models get the same initial messages
        roundMessages = initialMessages;
      } else {
        // Rebuttal rounds: each model gets messages with previous round's responses
        messagesPerModel = models.map(() =>
          buildRebuttalMessages({
            userPrompt,
            previousRoundStreams: lastCompletedStreams,
            roundNumber: roundNum,
            conversationHistory,
            focused,
          })
        );
      }

      const results = await runRound({
        models,
        messages: roundMessages,
        messagesPerModel,
        convId,
        roundIndex,
        apiKey,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        terminationReason = 'cancelled';
        break;
      }

      // Collect completed streams for this round
      const completedStreams = results.filter(r => r.content && !r.error);

      // If ALL models failed, stop the debate
      if (completedStreams.length === 0) {
        dispatch({
          type: 'UPDATE_ROUND_STATUS',
          payload: { conversationId: convId, roundIndex, status: 'error' },
        });
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
              dispatch({
                type: 'UPDATE_ROUND_STREAM',
                payload: {
                  conversationId: convId,
                  roundIndex,
                  streamIndex: result.index,
                  content: prev.content,
                  status: 'complete',
                  error: 'Failed this round — showing previous response',
                },
              });
            }
          }
        }
      }

      lastCompletedStreams = results
        .filter(r => r.content)
        .map(r => ({ model: r.model, content: r.content, status: 'complete' }));

      dispatch({
        type: 'UPDATE_ROUND_STATUS',
        payload: { conversationId: convId, roundIndex, status: 'complete' },
      });

      totalRounds = roundNum;

      // === CONVERGENCE CHECK (skip for round 1 and final round) ===
      if (roundNum >= 2 && roundNum < maxRounds) {
        if (abortController.signal.aborted) break;

        dispatch({
          type: 'SET_CONVERGENCE',
          payload: {
            conversationId: convId,
            roundIndex,
            convergenceCheck: { converged: null, reason: 'Checking...' },
          },
        });

        try {
          const convergenceMessages = buildConvergenceMessages({
            userPrompt,
            latestRoundStreams: lastCompletedStreams,
            roundNumber: roundNum,
          });

          const { content: convergenceResponse } = await chatCompletion({
            model: convergenceModel,
            messages: convergenceMessages,
            apiKey,
            signal: abortController.signal,
          });

          const parsed = parseConvergenceResponse(convergenceResponse);
          parsed.rawResponse = convergenceResponse;

          dispatch({
            type: 'SET_CONVERGENCE',
            payload: {
              conversationId: convId,
              roundIndex,
              convergenceCheck: parsed,
            },
          });

          if (parsed.converged) {
            converged = true;
            terminationReason = 'converged';
            break;
          }
        } catch (err) {
          if (abortController.signal.aborted) break;
          // Convergence check failed — continue debating
          dispatch({
            type: 'SET_CONVERGENCE',
            payload: {
              conversationId: convId,
              roundIndex,
              convergenceCheck: { converged: false, reason: 'Convergence check failed: ' + err.message },
            },
          });
        }
      }

      // If we've hit max rounds without convergence
      if (roundNum === maxRounds) {
        terminationReason = 'max_rounds_reached';
      }
    }

    if (abortController.signal.aborted) {
      dispatch({
        type: 'SET_DEBATE_METADATA',
        payload: {
          conversationId: convId,
          metadata: { totalRounds, converged: false, terminationReason: 'cancelled' },
        },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // Update debate metadata
    dispatch({
      type: 'SET_DEBATE_METADATA',
      payload: {
        conversationId: convId,
        metadata: {
          totalRounds,
          converged,
          terminationReason: terminationReason || 'max_rounds_reached',
        },
      },
    });

    // ===== SYNTHESIS =====
    if (!lastCompletedStreams || lastCompletedStreams.length === 0) {
      dispatch({
        type: 'UPDATE_SYNTHESIS',
        payload: {
          conversationId: convId,
          model: synthModel,
          content: '',
          status: 'error',
          error: 'All models failed. Cannot synthesize.',
        },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatch({
      type: 'UPDATE_SYNTHESIS',
      payload: {
        conversationId: convId,
        model: synthModel,
        content: '',
        status: 'streaming',
        error: null,
      },
    });

    // Build synthesis from final round's completed streams
    const synthesisMessages = buildMultiRoundSynthesisMessages({
      userPrompt,
      rounds: [{
        label: `Final positions after ${totalRounds} round(s)`,
        streams: lastCompletedStreams,
        convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null,
      }],
      conversationHistory,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await streamChat({
        model: synthModel,
        messages: synthesisMessages,
        apiKey,
        signal: abortController.signal,
        onChunk: (_delta, accumulated) => {
          dispatch({
            type: 'UPDATE_SYNTHESIS',
            payload: {
              conversationId: convId,
              model: synthModel,
              content: accumulated,
              status: 'streaming',
              error: null,
            },
          });
        },
      });

      dispatch({
        type: 'UPDATE_SYNTHESIS',
        payload: {
          conversationId: convId,
          model: synthModel,
          content: synthesisContent,
          status: 'complete',
          error: null,
          usage: synthesisUsage,
          durationMs: synthesisDurationMs,
        },
      });

      // Fire-and-forget title + description generation on first turn
      const currentConvForTitle = state.conversations.find(c => c.id === convId);
      const turnCount = currentConvForTitle ? currentConvForTitle.turns.length : 0;
      if (turnCount <= 1) {
        generateTitle({
          userPrompt,
          synthesisContent,
          apiKey,
        }).then(result => {
          dispatch({
            type: 'SET_CONVERSATION_TITLE',
            payload: { conversationId: convId, title: result.title },
          });
          if (result.description) {
            dispatch({
              type: 'SET_CONVERSATION_DESCRIPTION',
              payload: { conversationId: convId, description: result.description },
            });
          }
        }).catch(() => {
          // Title generation failed — not critical
        });
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatch({
          type: 'UPDATE_SYNTHESIS',
          payload: {
            conversationId: convId,
            model: synthModel,
            content: '',
            status: 'error',
            error: err.message,
          },
        });
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [state.apiKey, state.selectedModels, state.synthesizerModel, state.convergenceModel, state.maxDebateRounds, state.webSearchModel, state.activeConversationId, state.conversations, state.focusedMode]);

  /**
   * Run ensemble vote analysis (Phase 2) and streaming synthesis (Phase 3).
   * Extracted as a helper for reuse by startDirect and retry functions.
   */
  const runEnsembleAnalysisAndSynthesis = async ({
    convId, userPrompt, completedStreams, conversationHistory,
    synthModel, convergenceModel, apiKey, abortController, focused = false,
  }) => {
    // ===== PHASE 2: Vote Analysis =====
    dispatch({
      type: 'SET_ENSEMBLE_RESULT',
      payload: {
        conversationId: convId,
        ensembleResult: { status: 'analyzing', confidence: null, outliers: [], agreementAreas: [], disagreementAreas: [], modelWeights: {}, rawAnalysis: '', usage: null, durationMs: null },
      },
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

      dispatch({
        type: 'SET_ENSEMBLE_RESULT',
        payload: {
          conversationId: convId,
          ensembleResult: {
            status: 'complete',
            ...voteAnalysis,
            rawAnalysis: voteContent,
            usage: voteUsage,
            durationMs: voteDurationMs,
          },
        },
      });
    } catch (err) {
      if (abortController.signal.aborted) return false;
      // Vote analysis failed — continue with default weights
      voteAnalysis = { confidence: 50, outliers: [], agreementAreas: [], disagreementAreas: [], modelWeights: {} };
      dispatch({
        type: 'SET_ENSEMBLE_RESULT',
        payload: {
          conversationId: convId,
          ensembleResult: { status: 'error', ...voteAnalysis, rawAnalysis: '', usage: null, durationMs: null, error: err.message },
        },
      });
    }

    if (abortController.signal.aborted) return false;

    // ===== PHASE 3: Streaming Synthesis =====
    dispatch({
      type: 'UPDATE_SYNTHESIS',
      payload: { conversationId: convId, model: synthModel, content: '', status: 'streaming', error: null },
    });

    const synthesisMessages = buildEnsembleSynthesisMessages({
      userPrompt,
      streams: completedStreams,
      voteAnalysis,
      conversationHistory,
      focused,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await streamChat({
        model: synthModel,
        messages: synthesisMessages,
        apiKey,
        signal: abortController.signal,
        onChunk: (_delta, accumulated) => {
          dispatch({
            type: 'UPDATE_SYNTHESIS',
            payload: { conversationId: convId, model: synthModel, content: accumulated, status: 'streaming', error: null },
          });
        },
      });

      dispatch({
        type: 'UPDATE_SYNTHESIS',
        payload: { conversationId: convId, model: synthModel, content: synthesisContent, status: 'complete', error: null, usage: synthesisUsage, durationMs: synthesisDurationMs },
      });

      return synthesisContent;
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatch({
          type: 'UPDATE_SYNTHESIS',
          payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: err.message },
        });
      }
      return false;
    }
  };

  const startDirect = useCallback(async (userPrompt, { webSearch = false, attachments } = {}) => {
    const models = state.selectedModels;
    const synthModel = state.synthesizerModel;
    const convergenceModel = state.convergenceModel;
    const webSearchModel = state.webSearchModel;
    const apiKey = state.apiKey;
    const focused = state.focusedMode;

    // Create new conversation if none active
    let convId = state.activeConversationId;
    if (!convId) {
      convId = Date.now().toString();
      const title = userPrompt.length > 50
        ? userPrompt.slice(0, 50) + '...'
        : userPrompt;
      dispatch({ type: 'NEW_CONVERSATION', payload: { id: convId, title } });
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });

    // Build ensemble vote turn
    const turn = {
      id: Date.now().toString(),
      userPrompt,
      timestamp: Date.now(),
      attachments: attachments || null,
      mode: 'direct',
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

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // ===== WEB SEARCH (optional) =====
    let webSearchContext = '';
    if (webSearch && webSearchModel) {
      dispatch({
        type: 'SET_WEB_SEARCH_RESULT',
        payload: {
          conversationId: convId,
          result: { status: 'searching', content: '', model: webSearchModel, error: null },
        },
      });

      try {
        const searchPrompt = buildAttachmentTextContent(userPrompt, attachments);
        const { content: searchContent, durationMs: searchDurationMs } = await chatCompletion({
          model: webSearchModel,
          messages: [
            {
              role: 'system',
              content: 'Search the web to find current, accurate information relevant to the user\'s query. Provide a comprehensive summary of what you find, including key facts, data, and sources.',
            },
            { role: 'user', content: searchPrompt },
          ],
          apiKey,
          signal: abortController.signal,
        });

        webSearchContext = searchContent;
        dispatch({
          type: 'SET_WEB_SEARCH_RESULT',
          payload: {
            conversationId: convId,
            result: { status: 'complete', content: searchContent, model: webSearchModel, error: null, durationMs: searchDurationMs },
          },
        });
      } catch (err) {
        if (abortController.signal.aborted) {
          dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
          return;
        }
        dispatch({
          type: 'SET_WEB_SEARCH_RESULT',
          payload: {
            conversationId: convId,
            result: { status: 'error', content: '', model: webSearchModel, error: err.message },
          },
        });
      }
    }

    // Build conversation context
    const currentConv = state.conversations.find(c => c.id === convId);
    const { messages: contextMessages, needsSummary, turnsToSummarize } = buildConversationContext({
      conversation: currentConv,
      runningSummary: currentConv?.runningSummary || null,
    });

    // Background summarization if needed
    if (needsSummary && currentConv && turnsToSummarize > 0) {
      const turnsForSummary = currentConv.turns.slice(0, turnsToSummarize);
      const summaryMessages = buildSummaryPrompt({
        existingSummary: currentConv.runningSummary || null,
        turnsToSummarize: turnsForSummary,
      });
      chatCompletion({
        model: synthModel,
        messages: summaryMessages,
        apiKey,
        signal: abortController.signal,
      }).then(({ content: summary }) => {
        dispatch({
          type: 'SET_RUNNING_SUMMARY',
          payload: { conversationId: convId, summary },
        });
      }).catch(() => {});
    }

    const userMessageContent = webSearchContext
      ? `${userPrompt}\n\n---\n**Web Search Context (from ${webSearchModel}):**\n${webSearchContext}`
      : userPrompt;

    const conversationHistory = contextMessages;
    const userContent = buildAttachmentContent(userMessageContent, attachments);
    const focusedSystemMsg = focused ? [{ role: 'system', content: getFocusedEnsembleAnalysisPrompt() }] : [];
    const initialMessages = [...focusedSystemMsg, ...conversationHistory, { role: 'user', content: userContent }];

    // ===== PHASE 1: All debate models in parallel =====
    const roundLabel = focused ? 'Focused Analyses' : 'Independent Analyses';
    const round = createRound({ roundNumber: 1, label: roundLabel, models });

    dispatch({ type: 'ADD_ROUND', payload: { conversationId: convId, round } });
    dispatch({
      type: 'UPDATE_ROUND_STATUS',
      payload: { conversationId: convId, roundIndex: 0, status: 'streaming' },
    });

    const results = await runRound({
      models,
      messages: initialMessages,
      convId,
      roundIndex: 0,
      apiKey,
      signal: abortController.signal,
    });

    if (abortController.signal.aborted) {
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    const completedStreams = results
      .filter(r => r.content && !r.error)
      .map(r => ({ model: r.model, content: r.content, status: 'complete' }));

    if (completedStreams.length === 0) {
      dispatch({
        type: 'UPDATE_ROUND_STATUS',
        payload: { conversationId: convId, roundIndex: 0, status: 'error' },
      });
      dispatch({
        type: 'SET_DEBATE_METADATA',
        payload: { conversationId: convId, metadata: { totalRounds: 1, converged: false, terminationReason: 'all_models_failed' } },
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatch({
      type: 'UPDATE_ROUND_STATUS',
      payload: { conversationId: convId, roundIndex: 0, status: 'complete' },
    });

    // ===== PHASE 2 + 3: Vote Analysis & Synthesis =====
    const synthesisContent = await runEnsembleAnalysisAndSynthesis({
      convId, userPrompt, completedStreams, conversationHistory,
      synthModel, convergenceModel, apiKey, abortController, focused,
    });

    // Generate title on first turn
    if (synthesisContent) {
      const currentConvForTitle = state.conversations.find(c => c.id === convId);
      const turnCount = currentConvForTitle ? currentConvForTitle.turns.length : 0;
      if (turnCount <= 1) {
        generateTitle({
          userPrompt,
          synthesisContent,
          apiKey,
        }).then(result => {
          dispatch({
            type: 'SET_CONVERSATION_TITLE',
            payload: { conversationId: convId, title: result.title },
          });
          if (result.description) {
            dispatch({
              type: 'SET_CONVERSATION_DESCRIPTION',
              payload: { conversationId: convId, description: result.description },
            });
          }
        }).catch(() => {});
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [state.apiKey, state.selectedModels, state.synthesizerModel, state.convergenceModel, state.webSearchModel, state.activeConversationId, state.conversations, state.focusedMode]);

  const cancelDebate = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (activeConversation?.turns?.length) {
      const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
      if (lastTurn.rounds?.length) {
        const lastRoundIndex = lastTurn.rounds.length - 1;
        if (lastTurn.rounds[lastRoundIndex].status === 'streaming') {
          dispatch({
            type: 'UPDATE_ROUND_STATUS',
            payload: {
              conversationId: activeConversation.id,
              roundIndex: lastRoundIndex,
              status: 'error',
            },
          });
        }
      }
    }
    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [activeConversation, dispatch]);

  const editLastTurn = useCallback(() => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    dispatch({
      type: 'SET_EDITING_TURN',
      payload: { prompt: lastTurn.userPrompt, attachments: lastTurn.attachments, conversationId: activeConversation.id },
    });
  }, [activeConversation]);

  const retryLastTurn = useCallback(() => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    const prompt = lastTurn.userPrompt;
    const turnAttachments = lastTurn.attachments;
    const turnMode = lastTurn.mode;
    dispatch({ type: 'REMOVE_LAST_TURN', payload: activeConversation.id });
    const opts = {
      webSearch: state.webSearchEnabled,
      attachments: turnAttachments || undefined,
    };
    if (turnMode === 'direct') {
      startDirect(prompt, opts);
    } else {
      startDebate(prompt, opts);
    }
  }, [activeConversation, startDebate, startDirect, state.webSearchEnabled]);

  const retrySynthesis = useCallback(async () => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const convId = activeConversation.id;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    if (!lastTurn.rounds || lastTurn.rounds.length === 0) return;

    const userPrompt = lastTurn.userPrompt;
    const apiKey = state.apiKey;
    const synthModel = state.synthesizerModel;
    const convergModel = state.convergenceModel;

    // Gather completed streams from the final round
    const finalRound = lastTurn.rounds[lastTurn.rounds.length - 1];
    const lastCompletedStreams = finalRound.streams
      .filter(s => s.content && (s.status === 'complete' || s.error))
      .map(s => ({ model: s.model, content: s.content, status: 'complete' }));

    if (lastCompletedStreams.length === 0) return;

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build conversation context (excluding current turn)
    const convForContext = { ...activeConversation, turns: activeConversation.turns.slice(0, -1) };
    const { messages: contextMessages } = buildConversationContext({
      conversation: convForContext,
      runningSummary: activeConversation.runningSummary || null,
    });
    const conversationHistory = contextMessages;

    // Ensemble mode (direct turns): re-run vote analysis + synthesis
    if (lastTurn.mode === 'direct') {
      await runEnsembleAnalysisAndSynthesis({
        convId, userPrompt, completedStreams: lastCompletedStreams, conversationHistory,
        synthModel, convergenceModel: convergModel, apiKey, abortController, focused: state.focusedMode,
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // Debate mode: use the original multi-round synthesis path
    const converged = lastTurn.debateMetadata?.converged || false;
    const totalRounds = lastTurn.debateMetadata?.totalRounds || lastTurn.rounds.length;

    dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'streaming', error: null } });

    const synthesisMessages = buildMultiRoundSynthesisMessages({
      userPrompt,
      rounds: [{
        label: `Final positions after ${totalRounds} round(s)`,
        streams: lastCompletedStreams,
        convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null,
      }],
      conversationHistory,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await streamChat({
        model: synthModel,
        messages: synthesisMessages,
        apiKey,
        signal: abortController.signal,
        onChunk: (_delta, accumulated) => {
          dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: accumulated, status: 'streaming', error: null } });
        },
      });
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: synthesisContent, status: 'complete', error: null, usage: synthesisUsage, durationMs: synthesisDurationMs } });
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: err.message } });
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [activeConversation, state.apiKey, state.synthesizerModel, state.convergenceModel]);

  const retryRound = useCallback(async (roundIndex) => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const convId = activeConversation.id;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    if (!lastTurn.rounds || roundIndex >= lastTurn.rounds.length) return;

    const userPrompt = lastTurn.userPrompt;
    const attachments = lastTurn.attachments;
    const targetRound = lastTurn.rounds[roundIndex];
    const models = targetRound.streams.map(s => s.model);

    const apiKey = state.apiKey;
    const synthModel = state.synthesizerModel;
    const convergenceModel = state.convergenceModel;
    const maxRounds = state.maxDebateRounds;

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });
    dispatch({ type: 'TRUNCATE_ROUNDS', payload: { conversationId: convId, keepCount: roundIndex + 1 } });
    dispatch({ type: 'RESET_SYNTHESIS', payload: { conversationId: convId, model: synthModel } });

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build conversation context (excluding current turn)
    const convForContext = { ...activeConversation, turns: activeConversation.turns.slice(0, -1) };
    const { messages: contextMessages } = buildConversationContext({
      conversation: convForContext,
      runningSummary: activeConversation.runningSummary || null,
    });
    const conversationHistory = contextMessages;

    // Build web search context if present
    const webSearchResult = lastTurn.webSearchResult;
    const webSearchCtx = webSearchResult?.status === 'complete' ? webSearchResult.content : '';
    const wsModel = webSearchResult?.model || '';
    const userMessageContent = webSearchCtx
      ? `${userPrompt}\n\n---\n**Web Search Context (from ${wsModel}):**\n${webSearchCtx}`
      : userPrompt;
    const userContent = buildAttachmentContent(userMessageContent, attachments);
    const initialMessages = [...conversationHistory, { role: 'user', content: userContent }];

    // Get previous round streams for rebuttal context
    let previousRoundStreams = null;
    if (roundIndex > 0) {
      const prevRound = lastTurn.rounds[roundIndex - 1];
      previousRoundStreams = prevRound.streams
        .filter(s => s.content && s.status === 'complete')
        .map(s => ({ model: s.model, content: s.content, status: 'complete' }));
    }

    // Identify which streams need re-running (failed, stuck, or pending)
    const failedIndices = [];
    targetRound.streams.forEach((s, i) => {
      if (s.status !== 'complete' || !s.content) {
        failedIndices.push(i);
      }
    });

    // === ENSEMBLE (direct mode) retry: re-run all streams then vote + synthesis ===
    if (lastTurn.mode === 'direct') {
      dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex, status: 'streaming' } });

      const results = await runRound({
        models, messages: initialMessages, convId, roundIndex, apiKey, signal: abortController.signal,
      });

      if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }

      const completedStreams = results
        .filter(r => r.content && !r.error)
        .map(r => ({ model: r.model, content: r.content, status: 'complete' }));

      if (completedStreams.length === 0) {
        dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex, status: 'error' } });
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }

      dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex, status: 'complete' } });

      await runEnsembleAnalysisAndSynthesis({
        convId, userPrompt, completedStreams, conversationHistory,
        synthModel, convergenceModel, apiKey, abortController, focused: state.focusedMode,
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

      // Skip ahead to convergence + continuation
      let converged = false;
      let terminationReason = null;
      let totalRounds = roundIndex + 1;
      let currentRoundIndex = roundIndex;

      // Convergence check on current round
      if (totalRounds >= 2 && totalRounds < maxRounds && !abortController.signal.aborted) {
        dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: null, reason: 'Checking...' } } });
        try {
          const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: totalRounds });
          const { content: cResponse } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
          const parsed = parseConvergenceResponse(cResponse);
          parsed.rawResponse = cResponse;
          dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: parsed } });
          if (parsed.converged) { converged = true; terminationReason = 'converged'; }
        } catch (err) {
          if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }
          dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: false, reason: 'Convergence check failed: ' + err.message } } });
        }
      }

      // Continue with additional rounds if not converged
      if (!converged && !abortController.signal.aborted && totalRounds < maxRounds) {
        for (let roundNum = totalRounds + 1; roundNum <= maxRounds; roundNum++) {
          if (abortController.signal.aborted) break;
          const roundLabel = getRoundLabel(roundNum);
          const round = createRound({ roundNumber: roundNum, label: roundLabel, models });
          currentRoundIndex = roundNum - 1;
          dispatch({ type: 'ADD_ROUND', payload: { conversationId: convId, round } });
          dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'streaming' } });
          const messagesPerModel = models.map(() =>
            buildRebuttalMessages({ userPrompt, previousRoundStreams: lastCompletedStreams, roundNumber: roundNum, conversationHistory, focused: state.focusedMode })
          );
          const results = await runRound({ models, messagesPerModel, convId, roundIndex: currentRoundIndex, apiKey, signal: abortController.signal });
          if (abortController.signal.aborted) { terminationReason = 'cancelled'; break; }
          const completedStreams = results.filter(r => r.content && !r.error);
          if (completedStreams.length === 0) {
            dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'error' } });
            terminationReason = 'all_models_failed'; totalRounds = roundNum; break;
          }
          if (completedStreams.length < models.length) {
            for (const result of results) {
              if (result.error && !result.content) {
                const prev = lastCompletedStreams.find(s => s.model === result.model);
                if (prev) { result.content = prev.content; dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex: currentRoundIndex, streamIndex: result.index, content: prev.content, status: 'complete', error: 'Failed this round — showing previous response' } }); }
              }
            }
          }
          lastCompletedStreams = results.filter(r => r.content).map(r => ({ model: r.model, content: r.content, status: 'complete' }));
          dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'complete' } });
          totalRounds = roundNum;
          if (roundNum >= 2 && roundNum < maxRounds) {
            if (abortController.signal.aborted) break;
            dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: null, reason: 'Checking...' } } });
            try {
              const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: roundNum });
              const { content: cResponse } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
              const parsed = parseConvergenceResponse(cResponse);
              parsed.rawResponse = cResponse;
              dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: parsed } });
              if (parsed.converged) { converged = true; terminationReason = 'converged'; break; }
            } catch (err) {
              if (abortController.signal.aborted) break;
              dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: false, reason: 'Convergence check failed: ' + err.message } } });
            }
          }
          if (roundNum === maxRounds) terminationReason = 'max_rounds_reached';
        }
      } else if (totalRounds >= maxRounds) {
        terminationReason = terminationReason || 'max_rounds_reached';
      }

      if (abortController.signal.aborted) {
        dispatch({ type: 'SET_DEBATE_METADATA', payload: { conversationId: convId, metadata: { totalRounds, converged: false, terminationReason: 'cancelled' } } });
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }

      dispatch({ type: 'SET_DEBATE_METADATA', payload: { conversationId: convId, metadata: { totalRounds, converged, terminationReason: terminationReason || 'max_rounds_reached' } } });

      // Synthesis
      if (!lastCompletedStreams || lastCompletedStreams.length === 0) {
        dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: 'All models failed. Cannot synthesize.' } });
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'streaming', error: null } });
      const synthesisMessages = buildMultiRoundSynthesisMessages({
        userPrompt,
        rounds: [{ label: `Final positions after ${totalRounds} round(s)`, streams: lastCompletedStreams, convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null }],
        conversationHistory,
      });
      try {
        const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await streamChat({
          model: synthModel, messages: synthesisMessages, apiKey, signal: abortController.signal,
          onChunk: (_delta, accumulated) => { dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: accumulated, status: 'streaming', error: null } }); },
        });
        dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: synthesisContent, status: 'complete', error: null, usage: synthesisUsage, durationMs: synthesisDurationMs } });
      } catch (err) {
        if (!abortController.signal.aborted) { dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: err.message } }); }
      }
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // === Re-run only failed/stuck streams in parallel ===
    dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex, status: 'streaming' } });

    const retryResults = await Promise.allSettled(
      failedIndices.map(async (si) => {
        const model = models[si];
        // Build messages for this model
        let modelMessages;
        if (roundIndex === 0) {
          modelMessages = initialMessages;
        } else {
          modelMessages = buildRebuttalMessages({
            userPrompt,
            previousRoundStreams,
            roundNumber: roundIndex + 1,
            conversationHistory,
            focused: state.focusedMode,
          });
        }

        dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex, streamIndex: si, content: '', status: 'streaming', error: null } });

        try {
          const { content, reasoning, usage, durationMs } = await streamChat({
            model,
            messages: modelMessages,
            apiKey,
            signal: abortController.signal,
            onChunk: (_delta, accumulated) => {
              dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex, streamIndex: si, content: accumulated, status: 'streaming', error: null } });
            },
            onReasoning: (accumulatedReasoning) => {
              dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex, streamIndex: si, status: 'streaming', error: null, reasoning: accumulatedReasoning } });
            },
          });
          dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex, streamIndex: si, content, status: 'complete', error: null, usage, durationMs, reasoning: reasoning || null } });
          return { model, content, index: si };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          const errorMsg = err.message || 'An error occurred';
          dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex, streamIndex: si, content: '', status: 'error', error: errorMsg } });
          return { model, content: '', index: si, error: errorMsg };
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
      dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex, status: 'error' } });
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: 'All models failed. Cannot synthesize.' } });
      dispatch({ type: 'SET_DEBATE_METADATA', payload: { conversationId: convId, metadata: { totalRounds: roundIndex + 1, converged: false, terminationReason: 'all_models_failed' } } });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex, status: 'complete' } });

    // Continue debate from this round: convergence check + more rounds + synthesis
    let converged = false;
    let terminationReason = null;
    let totalRounds = roundIndex + 1;
    let currentRoundIndex = roundIndex;

    // Convergence check on current round
    if (totalRounds >= 2 && totalRounds < maxRounds && !abortController.signal.aborted) {
      dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: null, reason: 'Checking...' } } });
      try {
        const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: totalRounds });
        const { content: cResponse } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
        const parsed = parseConvergenceResponse(cResponse);
        parsed.rawResponse = cResponse;
        dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: parsed } });
        if (parsed.converged) { converged = true; terminationReason = 'converged'; }
      } catch (err) {
        if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }
        dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: false, reason: 'Convergence check failed: ' + err.message } } });
      }
    }

    // Continue with additional rounds if not converged
    if (!converged && !abortController.signal.aborted && totalRounds < maxRounds) {
      for (let roundNum = totalRounds + 1; roundNum <= maxRounds; roundNum++) {
        if (abortController.signal.aborted) break;
        const roundLabel = getRoundLabel(roundNum);
        const round = createRound({ roundNumber: roundNum, label: roundLabel, models });
        currentRoundIndex = roundNum - 1;
        dispatch({ type: 'ADD_ROUND', payload: { conversationId: convId, round } });
        dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'streaming' } });
        const messagesPerModel = models.map(() =>
          buildRebuttalMessages({ userPrompt, previousRoundStreams: lastCompletedStreams, roundNumber: roundNum, conversationHistory, focused: state.focusedMode })
        );
        const results = await runRound({ models, messagesPerModel, convId, roundIndex: currentRoundIndex, apiKey, signal: abortController.signal });
        if (abortController.signal.aborted) { terminationReason = 'cancelled'; break; }
        const completedStreams = results.filter(r => r.content && !r.error);
        if (completedStreams.length === 0) {
          dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'error' } });
          terminationReason = 'all_models_failed'; totalRounds = roundNum; break;
        }
        if (completedStreams.length < models.length) {
          for (const result of results) {
            if (result.error && !result.content) {
              const prev = lastCompletedStreams.find(s => s.model === result.model);
              if (prev) { result.content = prev.content; dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex: currentRoundIndex, streamIndex: result.index, content: prev.content, status: 'complete', error: 'Failed this round — showing previous response' } }); }
            }
          }
        }
        lastCompletedStreams = results.filter(r => r.content).map(r => ({ model: r.model, content: r.content, status: 'complete' }));
        dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'complete' } });
        totalRounds = roundNum;
        if (roundNum >= 2 && roundNum < maxRounds) {
          if (abortController.signal.aborted) break;
          dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: null, reason: 'Checking...' } } });
          try {
            const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: roundNum });
            const { content: cResponse } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
            const parsed = parseConvergenceResponse(cResponse);
            parsed.rawResponse = cResponse;
            dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: parsed } });
            if (parsed.converged) { converged = true; terminationReason = 'converged'; break; }
          } catch (err) {
            if (abortController.signal.aborted) break;
            dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: false, reason: 'Convergence check failed: ' + err.message } } });
          }
        }
        if (roundNum === maxRounds) terminationReason = 'max_rounds_reached';
      }
    } else if (totalRounds >= maxRounds) {
      terminationReason = terminationReason || 'max_rounds_reached';
    }

    if (abortController.signal.aborted) {
      dispatch({ type: 'SET_DEBATE_METADATA', payload: { conversationId: convId, metadata: { totalRounds, converged: false, terminationReason: 'cancelled' } } });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatch({ type: 'SET_DEBATE_METADATA', payload: { conversationId: convId, metadata: { totalRounds, converged, terminationReason: terminationReason || 'max_rounds_reached' } } });

    // Synthesis
    if (!lastCompletedStreams || lastCompletedStreams.length === 0) {
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: 'All models failed. Cannot synthesize.' } });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'streaming', error: null } });

    const synthesisMessages = buildMultiRoundSynthesisMessages({
      userPrompt,
      rounds: [{ label: `Final positions after ${totalRounds} round(s)`, streams: lastCompletedStreams, convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null }],
      conversationHistory,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await streamChat({
        model: synthModel, messages: synthesisMessages, apiKey, signal: abortController.signal,
        onChunk: (_delta, accumulated) => { dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: accumulated, status: 'streaming', error: null } }); },
      });
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: synthesisContent, status: 'complete', error: null, usage: synthesisUsage, durationMs: synthesisDurationMs } });
    } catch (err) {
      if (!abortController.signal.aborted) { dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: err.message } }); }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [activeConversation, state.apiKey, state.synthesizerModel, state.convergenceModel, state.maxDebateRounds]);

  const retryStream = useCallback(async (roundIndex, streamIndex) => {
    if (!activeConversation || activeConversation.turns.length === 0) return;
    const convId = activeConversation.id;
    const lastTurn = activeConversation.turns[activeConversation.turns.length - 1];
    if (!lastTurn.rounds || roundIndex >= lastTurn.rounds.length) return;

    const userPrompt = lastTurn.userPrompt;
    const attachments = lastTurn.attachments;
    const targetRound = lastTurn.rounds[roundIndex];
    const targetModel = targetRound.streams[streamIndex]?.model;
    if (!targetModel) return;

    const apiKey = state.apiKey;
    const synthModel = state.synthesizerModel;
    const convergenceModel = state.convergenceModel;
    const maxRounds = state.maxDebateRounds;
    const models = targetRound.streams.map(s => s.model);

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: true });
    dispatch({ type: 'TRUNCATE_ROUNDS', payload: { conversationId: convId, keepCount: roundIndex + 1 } });
    dispatch({ type: 'RESET_SYNTHESIS', payload: { conversationId: convId, model: synthModel } });

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build conversation context (excluding current turn)
    const convForContext = { ...activeConversation, turns: activeConversation.turns.slice(0, -1) };
    const { messages: contextMessages } = buildConversationContext({
      conversation: convForContext,
      runningSummary: activeConversation.runningSummary || null,
    });
    const conversationHistory = contextMessages;

    // Build web search context if present
    const webSearchResult = lastTurn.webSearchResult;
    const webSearchCtx = webSearchResult?.status === 'complete' ? webSearchResult.content : '';
    const wsModel = webSearchResult?.model || '';
    const userMessageContent = webSearchCtx
      ? `${userPrompt}\n\n---\n**Web Search Context (from ${wsModel}):**\n${webSearchCtx}`
      : userPrompt;
    const userContent = buildAttachmentContent(userMessageContent, attachments);
    const initialMessages = [...conversationHistory, { role: 'user', content: userContent }];

    // Build messages for this specific model in this round
    let modelMessages;
    if (roundIndex === 0) {
      modelMessages = initialMessages;
    } else {
      const prevRound = lastTurn.rounds[roundIndex - 1];
      const previousRoundStreams = prevRound.streams
        .filter(s => s.content && s.status === 'complete')
        .map(s => ({ model: s.model, content: s.content, status: 'complete' }));
      modelMessages = buildRebuttalMessages({
        userPrompt,
        previousRoundStreams,
        roundNumber: roundIndex + 1,
        conversationHistory,
        focused: state.focusedMode,
      });
    }

    // Reset and re-stream the target model
    dispatch({
      type: 'UPDATE_ROUND_STREAM',
      payload: { conversationId: convId, roundIndex, streamIndex, content: '', status: 'streaming', error: null },
    });

    // Track the retry result in a local variable so we can use it after the try/catch
    let retryResult = { content: '', succeeded: false };

    try {
      const { content, reasoning, usage, durationMs } = await streamChat({
        model: targetModel,
        messages: modelMessages,
        apiKey,
        signal: abortController.signal,
        onChunk: (_delta, accumulated) => {
          dispatch({
            type: 'UPDATE_ROUND_STREAM',
            payload: { conversationId: convId, roundIndex, streamIndex, content: accumulated, status: 'streaming', error: null },
          });
        },
        onReasoning: (accumulatedReasoning) => {
          dispatch({
            type: 'UPDATE_ROUND_STREAM',
            payload: { conversationId: convId, roundIndex, streamIndex, status: 'streaming', error: null, reasoning: accumulatedReasoning },
          });
        },
      });
      dispatch({
        type: 'UPDATE_ROUND_STREAM',
        payload: { conversationId: convId, roundIndex, streamIndex, content, status: 'complete', error: null, usage, durationMs, reasoning: reasoning || null },
      });
      retryResult = { content, succeeded: true };
    } catch (err) {
      if (abortController.signal.aborted) {
        dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
        return;
      }
      dispatch({
        type: 'UPDATE_ROUND_STREAM',
        payload: { conversationId: convId, roundIndex, streamIndex, content: '', status: 'error', error: err.message || 'An error occurred' },
      });
    }

    if (abortController.signal.aborted) {
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // Build lastCompletedStreams: other streams from this round + our retry result
    let lastCompletedStreams = targetRound.streams
      .filter((s, i) => i !== streamIndex && s.content && s.status === 'complete')
      .map(s => ({ model: s.model, content: s.content, status: 'complete' }));
    if (retryResult.succeeded) {
      lastCompletedStreams.push({ model: targetModel, content: retryResult.content, status: 'complete' });
    }

    if (lastCompletedStreams.length === 0) {
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: 'All models failed. Cannot synthesize.' } });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    // === ENSEMBLE (direct mode) stream retry: re-run vote + synthesis ===
    if (lastTurn.mode === 'direct') {
      await runEnsembleAnalysisAndSynthesis({
        convId, userPrompt, completedStreams: lastCompletedStreams, conversationHistory,
        synthModel, convergenceModel, apiKey, abortController, focused: state.focusedMode,
      });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    let currentRoundIndex = roundIndex;
    let converged = false;
    let terminationReason = null;
    let totalRounds = roundIndex + 1;

    // Convergence check on the current round (if applicable)
    if (totalRounds >= 2 && totalRounds < maxRounds && !abortController.signal.aborted) {
      dispatch({
        type: 'SET_CONVERGENCE',
        payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: null, reason: 'Checking...' } },
      });
      try {
        const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: totalRounds });
        const { content: cResponse } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
        const parsed = parseConvergenceResponse(cResponse);
        parsed.rawResponse = cResponse;
        dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: parsed } });
        if (parsed.converged) { converged = true; terminationReason = 'converged'; }
      } catch (err) {
        if (abortController.signal.aborted) { dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false }); return; }
        dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: false, reason: 'Convergence check failed: ' + err.message } } });
      }
    }

    // Continue with additional rounds if not converged
    if (!converged && !abortController.signal.aborted) {
      for (let roundNum = totalRounds + 1; roundNum <= maxRounds; roundNum++) {
        if (abortController.signal.aborted) break;

        const roundLabel = getRoundLabel(roundNum);
        const round = createRound({ roundNumber: roundNum, label: roundLabel, models });
        currentRoundIndex = roundNum - 1;

        dispatch({ type: 'ADD_ROUND', payload: { conversationId: convId, round } });
        dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'streaming' } });

        const messagesPerModel = models.map(() =>
          buildRebuttalMessages({ userPrompt, previousRoundStreams: lastCompletedStreams, roundNumber: roundNum, conversationHistory, focused: state.focusedMode })
        );

        const results = await runRound({ models, messagesPerModel, convId, roundIndex: currentRoundIndex, apiKey, signal: abortController.signal });

        if (abortController.signal.aborted) { terminationReason = 'cancelled'; break; }

        const completedStreams = results.filter(r => r.content && !r.error);
        if (completedStreams.length === 0) {
          dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'error' } });
          terminationReason = 'all_models_failed'; totalRounds = roundNum; break;
        }

        if (completedStreams.length < models.length) {
          for (const result of results) {
            if (result.error && !result.content) {
              const prev = lastCompletedStreams.find(s => s.model === result.model);
              if (prev) {
                result.content = prev.content;
                dispatch({ type: 'UPDATE_ROUND_STREAM', payload: { conversationId: convId, roundIndex: currentRoundIndex, streamIndex: result.index, content: prev.content, status: 'complete', error: 'Failed this round — showing previous response' } });
              }
            }
          }
        }

        lastCompletedStreams = results.filter(r => r.content).map(r => ({ model: r.model, content: r.content, status: 'complete' }));
        dispatch({ type: 'UPDATE_ROUND_STATUS', payload: { conversationId: convId, roundIndex: currentRoundIndex, status: 'complete' } });
        totalRounds = roundNum;

        if (roundNum >= 2 && roundNum < maxRounds) {
          if (abortController.signal.aborted) break;
          dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: null, reason: 'Checking...' } } });
          try {
            const cMsgs = buildConvergenceMessages({ userPrompt, latestRoundStreams: lastCompletedStreams, roundNumber: roundNum });
            const { content: cResponse } = await chatCompletion({ model: convergenceModel, messages: cMsgs, apiKey, signal: abortController.signal });
            const parsed = parseConvergenceResponse(cResponse);
            parsed.rawResponse = cResponse;
            dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: parsed } });
            if (parsed.converged) { converged = true; terminationReason = 'converged'; break; }
          } catch (err) {
            if (abortController.signal.aborted) break;
            dispatch({ type: 'SET_CONVERGENCE', payload: { conversationId: convId, roundIndex: currentRoundIndex, convergenceCheck: { converged: false, reason: 'Convergence check failed: ' + err.message } } });
          }
        }
        if (roundNum === maxRounds) terminationReason = 'max_rounds_reached';
      }
    }

    if (abortController.signal.aborted) {
      dispatch({ type: 'SET_DEBATE_METADATA', payload: { conversationId: convId, metadata: { totalRounds, converged: false, terminationReason: 'cancelled' } } });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatch({ type: 'SET_DEBATE_METADATA', payload: { conversationId: convId, metadata: { totalRounds, converged, terminationReason: terminationReason || 'max_rounds_reached' } } });

    // Synthesis
    if (!lastCompletedStreams || lastCompletedStreams.length === 0) {
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: 'All models failed. Cannot synthesize.' } });
      dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
      return;
    }

    dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'streaming', error: null } });

    const synthesisMessages = buildMultiRoundSynthesisMessages({
      userPrompt,
      rounds: [{ label: `Final positions after ${totalRounds} round(s)`, streams: lastCompletedStreams, convergenceCheck: converged ? { converged: true, reason: 'Models converged' } : null }],
      conversationHistory,
    });

    try {
      const { content: synthesisContent, usage: synthesisUsage, durationMs: synthesisDurationMs } = await streamChat({
        model: synthModel, messages: synthesisMessages, apiKey, signal: abortController.signal,
        onChunk: (_delta, accumulated) => {
          dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: accumulated, status: 'streaming', error: null } });
        },
      });
      dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: synthesisContent, status: 'complete', error: null, usage: synthesisUsage, durationMs: synthesisDurationMs } });
    } catch (err) {
      if (!abortController.signal.aborted) {
        dispatch({ type: 'UPDATE_SYNTHESIS', payload: { conversationId: convId, model: synthModel, content: '', status: 'error', error: err.message } });
      }
    }

    dispatch({ type: 'SET_DEBATE_IN_PROGRESS', payload: false });
  }, [activeConversation, state.apiKey, state.synthesizerModel, state.convergenceModel, state.maxDebateRounds]);

  const value = {
    ...state,
    activeConversation,
    dispatch,
    startDebate,
    startDirect,
    cancelDebate,
    editLastTurn,
    retryLastTurn,
    retryStream,
    retryRound,
    retrySynthesis,
  };

  return (
    <DebateContext.Provider value={value}>
      {children}
    </DebateContext.Provider>
  );
}

export function useDebate() {
  const context = useContext(DebateContext);
  if (!context) {
    throw new Error('useDebate must be used within a DebateProvider');
  }
  return context;
}
