import assert from 'node:assert/strict';
import {
  buildConversationTransferPacket,
  TRANSFER_PACKET_VARIANT_COMPACT,
  TRANSFER_PACKET_VARIANT_EXTENDED,
} from './transferPacket.js';

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
  return {
    id: 'conv-transfer',
    title: 'Refactor Transfer Handoff',
    description: 'Port the existing chat context into another LLM without dragging along raw JSON.',
    runningSummary: 'We decided a transfer packet is better than attaching exported JSON because it is smaller, easier to paste, and focuses the next model on the actual task.',
    turns: [
      {
        id: 'turn-1',
        userPrompt: 'Should we use JSON exports or a compact transfer packet?',
        contextSummary: 'User compared raw JSON export against a purpose-built transfer packet. Consensus: JSON is best for exact restore, but a transfer packet is better for continuing in another model.',
        synthesis: {
          content: 'Use JSON for exact restore. Use a transfer packet for efficient handoff to another LLM.',
          status: 'complete',
        },
        mode: 'debate',
        focusedMode: false,
        webSearchEnabled: false,
      },
      {
        id: 'turn-2',
        userPrompt: 'Implement compact and extended transfer modes.',
        contextSummary: 'Plan: Compact should be one concise handoff. Extended should include the compact handoff plus the last 1-3 turn summaries and key excerpts.',
        synthesis: {
          content: 'Add compact and extended transfer packets, with copy/download actions in the UI.',
          status: 'complete',
        },
        mode: 'debate',
        focusedMode: true,
        webSearchEnabled: true,
        attachments: [
          { name: 'handoff-notes.md' },
        ],
        webSearchResult: {
          status: 'complete',
          content: 'Search notes showed that users care more about portability than exact replay when switching tools.',
        },
      },
      {
        id: 'turn-3',
        userPrompt: 'Implement Compact: 1 concise handoff for another LLM. Extended: compact handoff plus last 1-3 turn summaries / key excerpts',
        contextSummary: 'Latest request is implementation-focused. The UI should expose copy/download actions for both variants without replacing the existing JSON or report export flows.',
        synthesis: {
          content: 'Implement a transfer packet builder and add UI controls for copy/download.',
          status: 'complete',
        },
        mode: 'debate',
        focusedMode: true,
        webSearchEnabled: true,
      },
    ],
  };
}

runTest('buildConversationTransferPacket creates a compact handoff with summary, active request, and constraints', () => {
  const packet = buildConversationTransferPacket(createConversationFixture(), {
    variant: TRANSFER_PACKET_VARIANT_COMPACT,
    generatedAt: '2026-04-10T12:34:56.000Z',
  });

  assert.match(packet, /# Transfer Packet \(Compact\)/);
  assert.match(packet, /Conversation: Refactor Transfer Handoff/);
  assert.match(packet, /Generated: 2026-04-10T12:34:56\.000Z/);
  assert.match(packet, /We decided a transfer packet is better than attaching exported JSON/);
  assert.match(packet, /Implement Compact: 1 concise handoff for another LLM/);
  assert.match(packet, /Implement a transfer packet builder and add UI controls for copy\/download/);
  assert.match(packet, /User preferred shorter, tighter replies\./);
  assert.match(packet, /Recent attachments referenced: handoff-notes\.md\./);
  assert.doesNotMatch(packet, /## Recent Turn Summaries/);
});

runTest('buildConversationTransferPacket extended mode includes the last three turn summaries', () => {
  const packet = buildConversationTransferPacket(createConversationFixture(), {
    variant: TRANSFER_PACKET_VARIANT_EXTENDED,
    generatedAt: '2026-04-10T12:34:56.000Z',
  });

  assert.match(packet, /# Transfer Packet \(Extended\)/);
  assert.match(packet, /## Recent Turn Summaries/);
  assert.match(packet, /### Turn 1/);
  assert.match(packet, /### Turn 2/);
  assert.match(packet, /### Turn 3/);
  assert.match(packet, /Compact should be one concise handoff/);
  assert.match(packet, /Latest request is implementation-focused/);
});

runTest('buildConversationTransferPacket falls back to earlier turn summaries when no running summary exists', () => {
  const conversation = createConversationFixture();
  conversation.turns.unshift({
    id: 'turn-0',
    userPrompt: 'Capture the original requirement.',
    contextSummary: 'Original requirement: make chat handoff efficient across tools instead of preserving every byte of app state.',
    synthesis: {
      content: 'The main goal is efficient context transfer to another chat or LLM.',
      status: 'complete',
    },
    mode: 'direct',
    focusedMode: false,
    webSearchEnabled: false,
  });
  delete conversation.runningSummary;

  const packet = buildConversationTransferPacket(conversation, {
    variant: TRANSFER_PACKET_VARIANT_COMPACT,
    generatedAt: '2026-04-10T12:34:56.000Z',
  });

  assert.match(packet, /## Established Context/);
  assert.match(packet, /Earlier turn 1:/);
  assert.match(packet, /Original requirement: make chat handoff efficient across tools/);
});

// eslint-disable-next-line no-console
console.log('Transfer packet tests completed.');
