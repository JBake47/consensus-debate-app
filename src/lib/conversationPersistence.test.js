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

// eslint-disable-next-line no-console
console.log('Conversation persistence tests completed.');
