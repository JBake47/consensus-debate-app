import assert from 'node:assert/strict';
import {
  buildConversationTransferPacket,
  buildConversationTransferPacketBundle,
  buildTransferPinsFromEditor,
  TRANSFER_PACKET_PROFILE_CODING,
  TRANSFER_PACKET_PROFILE_RESEARCH,
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
    runningSummary: [
      'We decided a transfer packet is better than attaching exported JSON because it is smaller and easier to paste.',
      'Compact should stay concise, while extended can carry extra recent context.',
      'The handoff must preserve durable facts, constraints, and the most recent answer.',
    ].join(' '),
    transferPins: {
      settledFacts: ['Users want efficient cross-chat handoff, not exact replay of every internal app field.'],
      constraints: ['Do not drop the latest answer from the transfer packet.'],
    },
    turns: [
      {
        id: 'turn-1',
        userPrompt: 'Should we use JSON exports or a compact transfer packet?',
        contextSummary: 'JSON is best for exact restore. A transfer packet is better for portability into another LLM.',
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
          model: 'openai/gpt-5.4',
        },
        mode: 'debate',
        focusedMode: true,
        webSearchEnabled: true,
        attachments: [
          {
            name: 'handoff-notes.md',
            category: 'text',
            type: 'text/markdown',
            content: 'Portability matters more than exact replay when switching tools.',
          },
        ],
        attachmentRouting: [
          { primaryLabel: 'Text fallback' },
        ],
      },
      {
        id: 'turn-3',
        userPrompt: 'Implement the transfer packet feature without losing the latest answer or provenance.',
        contextSummary: 'Latest request is implementation-focused. The UI should expose editable transfer packets and keep provenance plus the latest answer intact.',
        synthesis: {
          content: 'Implement a structured transfer packet builder and add an edit-before-copy flow in the UI.',
          status: 'complete',
          model: 'openai/gpt-5.4',
        },
        mode: 'debate',
        focusedMode: true,
        webSearchEnabled: true,
        modelOverrides: [
          'openai/gpt-5.4',
          'anthropic/claude-sonnet-4',
        ],
        webSearchResult: {
          status: 'complete',
          model: 'perplexity/sonar-pro',
          content: 'Sources: https://docs.example.com/packets (2026-04-10).',
        },
        rounds: [
          {
            roundNumber: 1,
            label: 'Round 1',
            streams: [
              {
                model: 'openai/gpt-5.4',
                status: 'complete',
                content: 'A structured packet should include the latest answer, clear buckets, and editable pins.',
                searchEvidence: {
                  urls: ['https://docs.example.com/packets'],
                  structuredCitations: [
                    {
                      url: 'https://docs.example.com/packets',
                      title: 'Transfer packet design notes',
                      publishedAt: '2026-04-10',
                      snippet: 'Transfer packets work best when they preserve the latest answer and explicit constraints.',
                      domain: 'docs.example.com',
                    },
                  ],
                },
              },
              {
                model: 'anthropic/claude-sonnet-4',
                status: 'complete',
                content: 'The packet should also preserve disagreements and source provenance so the next model does not overstate certainty.',
                searchEvidence: {
                  urls: ['https://research.example.com/handoffs'],
                  structuredCitations: [
                    {
                      url: 'https://research.example.com/handoffs',
                      title: 'LLM handoff patterns',
                      publishedAt: '2026-04-09',
                      snippet: 'Explicit disagreement capture improves continuation quality in cross-model workflows.',
                      domain: 'research.example.com',
                    },
                  ],
                },
              },
            ],
            convergenceCheck: {
              converged: false,
              reason: 'Models agree on structure but disagree on how much machine-readable data to include.',
              agreements: [
                'The latest answer should be included explicitly.',
              ],
              disagreements: [
                {
                  point: 'How much structured data to include in compact mode',
                  models: {
                    'openai/gpt-5.4': 'Include a compact JSON block.',
                    'anthropic/claude-sonnet-4': 'Keep the machine-readable block minimal.',
                  },
                },
              ],
            },
          },
        ],
        debateMetadata: {
          totalRounds: 1,
          converged: false,
          terminationReason: 'completed',
        },
      },
    ],
  };
}

runTest('compact bundle exposes structured buckets, run settings, provenance, and pins', () => {
  const bundle = buildConversationTransferPacketBundle(createConversationFixture(), {
    variant: TRANSFER_PACKET_VARIANT_COMPACT,
    generatedAt: '2026-04-12T12:34:56.000Z',
  });

  assert.equal(bundle.meta.variant, TRANSFER_PACKET_VARIANT_COMPACT);
  assert.match(bundle.text, /# Transfer Packet \(Compact\)/);
  assert.match(bundle.text, /## Objective/);
  assert.match(bundle.text, /## Latest Question Answered/);
  assert.match(bundle.text, /## Most Recent Answer/);
  assert.match(bundle.text, /## Settled Facts/);
  assert.match(bundle.text, /## Decisions Made/);
  assert.match(bundle.text, /## Open Questions/);
  assert.match(bundle.text, /## Constraints/);
  assert.match(bundle.text, /## Next Action/);
  assert.match(bundle.text, /## Run Settings/);
  assert.match(bundle.text, /## Source Provenance/);
  assert.match(bundle.text, /## Attachment Context/);
  assert.match(bundle.text, /## Machine Readable/);
  assert.match(bundle.text, /Users want efficient cross-chat handoff/);
  assert.match(bundle.text, /Do not drop the latest answer from the transfer packet/);
  assert.match(bundle.text, /Search model: perplexity\/sonar-pro\./);
  assert.match(bundle.text, /Model roster: openai\/gpt-5\.4, anthropic\/claude-sonnet-4\./);
  assert.match(bundle.text, /\[Transfer packet design notes\]\(https:\/\/docs\.example\.com\/packets\) \(2026-04-10\)/);
  assert.match(bundle.text, /handoff-notes\.md: Text document; routing text fallback; contains Portability matters more than exact replay when switching tools\./);
  assert.match(bundle.text, /How much structured data to include in compact mode/);
  assert.match(bundle.text, /"profile": "general"/);
  assert.match(bundle.text, /"searchModel": "perplexity\/sonar-pro"/);
  assert.match(bundle.text, /"modelRoster": \[\s*"openai\/gpt-5\.4",\s*"anthropic\/claude-sonnet-4"/);
  assert.ok(bundle.meta.totalChars > 0);
  assert.ok(bundle.meta.approxTokens > 0);
});

runTest('extended research packet keeps recent turn summaries and disagreement-focused context', () => {
  const packet = buildConversationTransferPacket(createConversationFixture(), {
    variant: TRANSFER_PACKET_VARIANT_EXTENDED,
    profile: TRANSFER_PACKET_PROFILE_RESEARCH,
    generatedAt: '2026-04-12T12:34:56.000Z',
  });

  assert.match(packet, /# Transfer Packet \(Extended\)/);
  assert.match(packet, /Profile: Research/);
  assert.match(packet, /## Recent Turn Summaries/);
  assert.match(packet, /### Turn 1/);
  assert.match(packet, /### Turn 2/);
  assert.match(packet, /### Turn 3/);
  assert.match(packet, /## Disagreements/);
  assert.match(packet, /Explicit disagreement capture improves continuation quality/);
});

runTest('active conversations are labeled as active requests instead of answered questions', () => {
  const conversation = createConversationFixture();
  conversation.turns.push({
    id: 'turn-4',
    userPrompt: 'Now convert the packet into a coding-focused handoff.',
    contextSummary: 'The latest request is still pending.',
    synthesis: {
      content: '',
      status: 'pending',
      model: 'openai/gpt-5.4',
    },
    mode: 'direct',
    focusedMode: true,
    webSearchEnabled: false,
    debateMetadata: {
      totalRounds: 1,
      converged: false,
      terminationReason: 'pending',
    },
  });

  const packet = buildConversationTransferPacket(conversation, {
    variant: TRANSFER_PACKET_VARIANT_COMPACT,
    profile: TRANSFER_PACKET_PROFILE_CODING,
    generatedAt: '2026-04-12T12:34:56.000Z',
  });

  assert.match(packet, /Profile: Coding/);
  assert.match(packet, /## Active Request/);
  assert.doesNotMatch(packet, /## Latest Question Answered/);
  assert.match(packet, /Now convert the packet into a coding-focused handoff\./);
});

runTest('debate turns with pending synthesis stay active even if round outputs already exist', () => {
  const conversation = createConversationFixture();
  conversation.turns.push({
    id: 'turn-4',
    userPrompt: 'Refine the packet for an in-progress coding handoff.',
    contextSummary: 'The model rounds are done, but synthesis is still pending.',
    synthesis: {
      content: 'Partial synthesis carried forward during retry.',
      status: 'streaming',
      model: 'openai/gpt-5.4',
    },
    mode: 'debate',
    focusedMode: true,
    webSearchEnabled: false,
    modelOverrides: [
      'openai/gpt-5.4',
      'anthropic/claude-sonnet-4',
    ],
    rounds: [
      {
        roundNumber: 1,
        label: 'Round 1',
        streams: [
          {
            model: 'openai/gpt-5.4',
            status: 'complete',
            content: 'Keep the packet implementation-focused.',
          },
          {
            model: 'anthropic/claude-sonnet-4',
            status: 'complete',
            content: 'Keep provenance and pinned constraints intact.',
          },
        ],
      },
    ],
    debateMetadata: {
      totalRounds: 1,
      converged: false,
      terminationReason: 'pending',
    },
  });

  const packet = buildConversationTransferPacket(conversation, {
    variant: TRANSFER_PACKET_VARIANT_COMPACT,
    generatedAt: '2026-04-12T12:34:56.000Z',
  });

  assert.match(packet, /## Active Request/);
  assert.doesNotMatch(packet, /## Latest Question Answered/);
  assert.match(packet, /## Latest Turn State/);
  assert.doesNotMatch(packet, /Partial synthesis carried forward during retry\./);
});

runTest('buildTransferPinsFromEditor parses line-based pin input', () => {
  const pins = buildTransferPinsFromEditor({
    settledFactsText: '- First fact\nSecond fact\n',
    constraintsText: 'Keep citations\nKeep latest answer\nKeep citations',
  });

  assert.deepEqual(pins, {
    settledFacts: ['First fact', 'Second fact'],
    constraints: ['Keep citations', 'Keep latest answer'],
  });
});

runTest('empty optional sections are not reported as size omissions', () => {
  const bundle = buildConversationTransferPacketBundle({
    id: 'conv-minimal',
    title: 'Minimal Transfer Packet',
    turns: [
      {
        id: 'turn-1',
        userPrompt: 'Continue the task.',
        contextSummary: 'Continue the current task without restarting.',
        synthesis: {
          content: 'Continue the current task without restarting.',
          status: 'complete',
          model: 'openai/gpt-5.4',
        },
        mode: 'direct',
        focusedMode: false,
        webSearchEnabled: false,
      },
    ],
  }, {
    variant: TRANSFER_PACKET_VARIANT_COMPACT,
    generatedAt: '2026-04-12T12:34:56.000Z',
  });

  assert.deepEqual(bundle.meta.omittedSections, []);
  assert.deepEqual(bundle.meta.warnings, []);
});

runTest('legacy string-shaped transfer pins are normalized by line', () => {
  const bundle = buildConversationTransferPacketBundle({
    ...createConversationFixture(),
    transferPins: {
      facts: '- First pinned fact\nSecond pinned fact\n',
      constraints: 'Keep citations\nKeep latest answer\nKeep citations',
    },
  }, {
    variant: TRANSFER_PACKET_VARIANT_COMPACT,
    generatedAt: '2026-04-12T12:34:56.000Z',
  });

  assert.deepEqual(bundle.packet.pins, {
    settledFacts: ['First pinned fact', 'Second pinned fact'],
    constraints: ['Keep citations', 'Keep latest answer'],
  });
  assert.match(bundle.text, /First pinned fact/);
  assert.match(bundle.text, /Keep latest answer/);
});

// eslint-disable-next-line no-console
console.log('Transfer packet tests completed.');
