import { prepareConversationsForPersistence } from './conversationPersistence.js';
import {
  mergeConversationStoreSnapshots,
  normalizeConversationStoreSnapshot,
} from './conversationStoreSnapshot.js';

const CONVERSATION_STORE_DB_NAME = 'consensus-conversations';
const CONVERSATION_STORE_DB_VERSION = 1;
const CONVERSATION_STORE_NAME = 'snapshots';
const CONVERSATION_STORE_KEY = 'latest';
const CONVERSATION_STORE_STRATEGIES = ['balanced', 'aggressive', 'minimal'];
const CONVERSATION_STORE_LOCK_NAME = 'consensus-conversation-store';

let conversationStoreDbPromise = null;
let queuedPersistPromise = Promise.resolve();

function getIndexedDbApi() {
  if (typeof globalThis === 'undefined') return null;
  return globalThis.indexedDB || null;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
  });
}

function normalizeSnapshot(snapshot, strategy = 'balanced') {
  const normalized = normalizeConversationStoreSnapshot({
    ...snapshot,
    strategy,
  });
  return {
    savedAt: Date.now(),
    strategy,
    activeConversationId: normalized.activeConversationId,
    conversations: normalized.conversations,
    deletedConversationTombstones: normalized.deletedConversationTombstones,
  };
}

async function withConversationStoreLock(task) {
  const lockManager = globalThis.navigator?.locks;
  if (!lockManager?.request) {
    return task();
  }
  return lockManager.request(CONVERSATION_STORE_LOCK_NAME, { mode: 'exclusive' }, task);
}

async function openConversationStoreDb() {
  const indexedDb = getIndexedDbApi();
  if (!indexedDb) return null;

  if (!conversationStoreDbPromise) {
    conversationStoreDbPromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(CONVERSATION_STORE_DB_NAME, CONVERSATION_STORE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CONVERSATION_STORE_NAME)) {
          db.createObjectStore(CONVERSATION_STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          conversationStoreDbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        conversationStoreDbPromise = null;
        reject(request.error || new Error('Failed to open conversation store.'));
      };
    });
  }

  try {
    return await conversationStoreDbPromise;
  } catch (error) {
    conversationStoreDbPromise = null;
    throw error;
  }
}

async function readConversationSnapshot(db) {
  const transaction = db.transaction(CONVERSATION_STORE_NAME, 'readonly');
  const store = transaction.objectStore(CONVERSATION_STORE_NAME);
  const snapshot = await requestToPromise(store.get(CONVERSATION_STORE_KEY));
  await transactionToPromise(transaction);
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }
  return normalizeConversationStoreSnapshot(snapshot);
}

async function writeConversationSnapshot(db, snapshot) {
  const transaction = db.transaction(CONVERSATION_STORE_NAME, 'readwrite');
  const store = transaction.objectStore(CONVERSATION_STORE_NAME);
  store.put(snapshot, CONVERSATION_STORE_KEY);
  await transactionToPromise(transaction);
}

async function persistConversationSnapshot(snapshot) {
  const db = await openConversationStoreDb();
  if (!db) {
    return {
      ok: false,
      strategy: null,
      error: new Error('IndexedDB is unavailable.'),
    };
  }

  return withConversationStoreLock(async () => {
    let lastError = null;

    for (const strategy of CONVERSATION_STORE_STRATEGIES) {
      try {
        const latestSnapshot = await readConversationSnapshot(db);
        const preparedIncomingSnapshot = normalizeSnapshot({
          ...snapshot,
          conversations: prepareConversationsForPersistence(snapshot?.conversations, strategy),
        }, strategy);
        const preparedSnapshot = normalizeSnapshot(
          mergeConversationStoreSnapshots(latestSnapshot, preparedIncomingSnapshot),
          strategy,
        );

        await writeConversationSnapshot(db, preparedSnapshot);
        return {
          ok: true,
          strategy,
          savedAt: preparedSnapshot.savedAt,
          snapshot: preparedSnapshot,
        };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      ok: false,
      strategy: null,
      error: lastError || new Error('Failed to persist conversation snapshot.'),
    };
  });
}

export async function loadConversationStoreSnapshot() {
  try {
    const db = await openConversationStoreDb();
    if (!db) return null;
    return await readConversationSnapshot(db);
  } catch {
    return null;
  }
}

export function queueConversationStorePersist(snapshot) {
  queuedPersistPromise = queuedPersistPromise
    .catch(() => undefined)
    .then(() => persistConversationSnapshot(snapshot));
  return queuedPersistPromise;
}
