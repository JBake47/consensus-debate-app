import assert from 'node:assert/strict';
import {
  buildConversationSearchIndex,
  searchConversationIndex,
} from './searchConversations.js';

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

runTest('buildConversationSearchIndex uses cached sidebar metadata', () => {
  const index = buildConversationSearchIndex([{
    id: 'conv-1',
    title: 'Quarterly planning',
    updatedAt: 10,
    sidebarData: {
      headerSections: [{ matchType: 'title', text: 'Quarterly planning', turnIndex: null }],
      turnEntries: [{
        turnId: 'turn-1',
        turnIndex: 0,
        sections: [{ matchType: 'synthesis', text: 'Launch timeline moved to April', turnIndex: 0 }],
      }],
    },
  }]);

  const results = searchConversationIndex(index, 'april');
  assert.equal(results.length, 1);
  assert.equal(results[0].conversationId, 'conv-1');
  assert.equal(results[0].matchType, 'synthesis');
});

runTest('search index falls back to turn searchSections when sidebar metadata is missing', () => {
  const index = buildConversationSearchIndex([{
    id: 'conv-2',
    title: 'Fallback',
    updatedAt: 20,
    turns: [{
      userPrompt: 'How do we handle imports?',
      searchSections: [{ matchType: 'prompt', text: 'Handle imports through staged validation', turnIndex: 0 }],
    }],
  }]);

  const results = searchConversationIndex(index, 'staged');
  assert.equal(results.length, 1);
  assert.equal(results[0].conversationId, 'conv-2');
  assert.equal(results[0].matchType, 'prompt');
});

// eslint-disable-next-line no-console
console.log('Conversation search tests completed.');
