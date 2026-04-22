import assert from 'node:assert/strict';
import {
  persistConversationsSnapshot,
  prepareConversationsForPersistence,
} from './conversationPersistence.js';

function runTest(name, fn) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

function createConversationFixture() {
  return [{
    id: 'conv-1',
    title: 'Persistence test',
    runningSummary: 's'.repeat(140000),
    turns: [{
      id: 'turn-1',
      userPrompt: 'Explain the issue',
      attachments: [
        {
          name: 'notes.txt',
          size: 1234,
          type: 'text/plain',
          category: 'text',
          dataUrl: 'data:text/plain;base64,abc123',
          content: 'x'.repeat(70000),
          inlineWarning: null,
        },
        {
          name: 'diagram.png',
          size: 4567,
          type: 'image/png',
          category: 'image',
          dataUrl: `data:image/png;base64,${'a'.repeat(400000)}`,
          content: `data:image/png;base64,${'a'.repeat(400000)}`,
          inlineWarning: null,
        },
      ],
      webSearchResult: {
        status: 'complete',
        content: 'w'.repeat(50000),
      },
      rounds: [{
        roundNumber: 1,
        status: 'complete',
        streams: [{
          model: 'openai/test',
          content: 'Final model answer',
          status: 'complete',
          error: null,
          reasoning: 'r'.repeat(90000),
        }],
      }],
      synthesis: {
        model: 'openai/test',
        content: 'Final synthesized answer',
        status: 'complete',
        error: null,
      },
    }],
  }];
}

function createConversationWithOverrides(overrides = {}) {
  const [baseConversation] = createConversationFixture();
  const conversation = JSON.parse(JSON.stringify(baseConversation));
  return {
    ...conversation,
    ...overrides,
    turns: Array.isArray(overrides.turns) ? overrides.turns : conversation.turns,
  };
}

runTest('prepareConversationsForPersistence trims bulky attachment and reasoning payloads', () => {
  const prepared = prepareConversationsForPersistence(createConversationFixture(), 'balanced');
  const turn = prepared[0].turns[0];
  const textAttachment = turn.attachments[0];
  const imageAttachment = turn.attachments[1];
  const stream = turn.rounds[0].streams[0];

  assert.equal(textAttachment.dataUrl, null);
  assert.equal(textAttachment.content.length, 64000);
  assert.match(textAttachment.inlineWarning, /truncated/i);
  assert.equal(imageAttachment.content, '');
  assert.equal(imageAttachment.dataUrl, null);
  assert.match(imageAttachment.inlineWarning, /reattach/i);
  assert.equal(stream.reasoning.length, 80000);
  assert.equal(turn.webSearchResult.content.length, 40000);
  assert.equal(prepared[0].runningSummary.length, 120000);
});

runTest('prepareConversationsForPersistence drops PDF OCR page snapshots', () => {
  const fixture = createConversationFixture();
  fixture[0].turns[0].attachments.push({
    name: 'scan.pdf',
    size: 2048,
    type: 'application/pdf',
    category: 'pdf',
    dataUrl: 'data:application/pdf;base64,abc123',
    content: '',
    inlineWarning: 'OCR pending.',
    pdfRequiresOcr: true,
    pdfOcrPages: [{
      pageNumber: 1,
      dataUrl: `data:image/jpeg;base64,${'a'.repeat(50000)}`,
    }],
  });

  const prepared = prepareConversationsForPersistence(fixture, 'balanced');
  const pdfAttachment = prepared[0].turns[0].attachments[2];
  assert.equal(pdfAttachment.pdfOcrPages, undefined);
  assert.match(pdfAttachment.inlineWarning, /snapshots were trimmed/i);
});

runTest('persistConversationsSnapshot falls back to a smaller strategy when storage is tight', () => {
  const fixture = createConversationFixture();
  const balancedBytes = JSON.stringify(prepareConversationsForPersistence(fixture, 'balanced')).length;
  const aggressiveBytes = JSON.stringify(prepareConversationsForPersistence(fixture, 'aggressive')).length;
  const byteLimit = Math.floor((balancedBytes + aggressiveBytes) / 2);
  let writes = 0;
  let storedValue = '';

  const storage = {
    setItem(_key, value) {
      writes += 1;
      if (value.length > byteLimit) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      storedValue = value;
    },
  };

  const result = persistConversationsSnapshot(storage, 'debate_conversations', fixture, { logger: null });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'aggressive');
  assert.ok(writes >= 2);
  assert.ok(storedValue.length <= byteLimit);
});

runTest('minimal persistence fallback keeps visible answers even after dropping extras', () => {
  const fixture = createConversationFixture();
  const aggressiveBytes = JSON.stringify(prepareConversationsForPersistence(fixture, 'aggressive')).length;
  const minimalBytes = JSON.stringify(prepareConversationsForPersistence(fixture, 'minimal')).length;
  const byteLimit = Math.floor((aggressiveBytes + minimalBytes) / 2);
  let storedValue = '';

  const storage = {
    setItem(_key, value) {
      if (value.length > byteLimit) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      storedValue = value;
    },
  };

  const result = persistConversationsSnapshot(storage, 'debate_conversations', fixture, { logger: null });
  const parsed = JSON.parse(storedValue);
  const turn = parsed[0].turns[0];
  const stream = turn.rounds[0].streams[0];

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'minimal');
  assert.equal(stream.content, 'Final model answer');
  assert.equal(stream.reasoning, null);
  assert.equal(turn.synthesis.content, 'Final synthesized answer');
  assert.equal(turn.attachments[0].content, '');
  assert.equal(turn.attachments[1].dataUrl, null);
});

runTest('quota fallback prefers live and recent chats over older completed history', () => {
  const oldConversation = createConversationWithOverrides({
    id: 'conv-old',
    title: 'Old chat',
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  const recentConversation = createConversationWithOverrides({
    id: 'conv-recent',
    title: 'Recent chat',
    createdAt: 2_000,
    updatedAt: 4_000,
  });
  const liveConversation = createConversationWithOverrides({
    id: 'conv-live',
    title: 'Interrupted chat',
    createdAt: 3_000,
    updatedAt: 3_000,
    turns: [{
      ...createConversationFixture()[0].turns[0],
      id: 'turn-live',
      activeRunId: 'run-live',
      lastRunActivityAt: 5_000,
      webSearchResult: {
        status: 'searching',
        content: '',
      },
      rounds: [{
        roundNumber: 1,
        status: 'streaming',
        streams: [{
          model: 'openai/test',
          content: 'Partial answer',
          status: 'streaming',
          error: null,
        }],
      }],
      synthesis: {
        model: 'openai/test',
        content: '',
        status: 'pending',
        error: null,
      },
    }],
  });
  const fixture = [oldConversation, recentConversation, liveConversation];
  const keepIds = ['conv-recent', 'conv-live'];
  const keepSubset = fixture.filter((conversation) => keepIds.includes(conversation.id));
  const fullMinimalBytes = JSON.stringify(prepareConversationsForPersistence(fixture, 'minimal')).length;
  const keepMinimalBytes = JSON.stringify(prepareConversationsForPersistence(keepSubset, 'minimal')).length;
  const byteLimit = Math.floor((fullMinimalBytes + keepMinimalBytes) / 2);
  let storedValue = '';

  const storage = {
    setItem(_key, value) {
      if (value.length > byteLimit) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      storedValue = value;
    },
  };

  const result = persistConversationsSnapshot(storage, 'debate_conversations', fixture, { logger: null });
  const parsed = JSON.parse(storedValue);

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'minimal');
  assert.equal(result.retainedConversationCount, 2);
  assert.equal(result.droppedConversationCount, 1);
  assert.deepEqual(parsed.map((conversation) => conversation.id), keepIds);
});

// eslint-disable-next-line no-console
console.log('Conversation persistence tests completed.');
