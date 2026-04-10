import assert from 'node:assert/strict';
import {
  buildModelUpgradeSuggestionKey,
  buildModelUpgradeSuggestions,
  buildConfiguredModelUpgradeTargets,
  findBestModelUpgrade,
  getModelUpgradeTargetKey,
  getModelUpgradeTrack,
} from './modelUpgrades.js';

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

runTest('findBestModelUpgrade picks the newest safe same-track release', () => {
  const catalog = {
    'openai/gpt-5.1': {
      id: 'openai/gpt-5.1',
      context_length: 200000,
      max_output_tokens: 16000,
      pricing: { prompt: 0.000003, completion: 0.000012 },
      created_at: '2026-01-01T00:00:00Z',
    },
    'openai/gpt-5.2': {
      id: 'openai/gpt-5.2',
      context_length: 200000,
      max_output_tokens: 16000,
      pricing: { prompt: 0.000003, completion: 0.000012 },
      created_at: '2026-02-01T00:00:00Z',
    },
    'openai/gpt-5.4': {
      id: 'openai/gpt-5.4',
      context_length: 200000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.000003, completion: 0.000012 },
      created_at: '2026-03-01T00:00:00Z',
    },
  };

  const result = findBestModelUpgrade('openai/gpt-5.1', catalog);
  assert.ok(result);
  assert.equal(result.suggestedModel, 'openai/gpt-5.4');
  assert.equal(getModelUpgradeTrack(result.currentModel), 'gpt');
});

runTest('findBestModelUpgrade treats dotted minor releases as the same upgrade family', () => {
  const catalog = {
    'z-ai/glm-5': {
      id: 'z-ai/glm-5',
      context_length: 128000,
      max_output_tokens: 16000,
      pricing: { prompt: 0.000001, completion: 0.000004 },
      created_at: '2026-01-15T00:00:00Z',
    },
    'z-ai/glm-5.1': {
      id: 'z-ai/glm-5.1',
      context_length: 128000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.000001, completion: 0.000004 },
      created_at: '2026-03-15T00:00:00Z',
    },
  };

  const result = findBestModelUpgrade('z-ai/glm-5', catalog);
  assert.ok(result);
  assert.equal(result.suggestedModel, 'z-ai/glm-5.1');
});

runTest('findBestModelUpgrade does not cross into a different variant track', () => {
  const catalog = {
    'openai/gpt-5.1': {
      id: 'openai/gpt-5.1',
      context_length: 200000,
      max_output_tokens: 16000,
      pricing: { prompt: 0.000003, completion: 0.000012 },
      created_at: '2026-01-01T00:00:00Z',
    },
    'openai/gpt-5.4-codex': {
      id: 'openai/gpt-5.4-codex',
      context_length: 200000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.000003, completion: 0.000012 },
      created_at: '2026-03-09T00:00:00Z',
    },
  };

  const result = findBestModelUpgrade('openai/gpt-5.1', catalog);
  assert.equal(result, null);
});

runTest('findBestModelUpgrade falls back to notify-only upgrades when newer releases are not safe', () => {
  const catalog = {
    'google/gemini-2.5-pro': {
      id: 'google/gemini-2.5-pro',
      context_length: 1000000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.0000025, completion: 0.00001 },
      created_at: '2026-01-01T00:00:00Z',
    },
    'google/gemini-2.5-pro-preview': {
      id: 'google/gemini-2.5-pro-preview',
      context_length: 1000000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.0000025, completion: 0.00001 },
      created_at: '2026-02-01T00:00:00Z',
      description: 'Preview build',
    },
    'google/gemini-2.5-pro-plus': {
      id: 'google/gemini-2.5-pro-plus',
      context_length: 1000000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.00001, completion: 0.00003 },
      created_at: '2026-03-01T00:00:00Z',
    },
  };

  const result = findBestModelUpgrade('google/gemini-2.5-pro', catalog);
  assert.ok(result);
  assert.equal(result.suggestedModel, 'google/gemini-2.5-pro-preview');
  assert.equal(result.isSafe, false);
  assert.match(result.safetyMessage, /Preview-only release/i);
});

runTest('buildModelUpgradeSuggestions aggregates roles and preserves direct-provider formatting', () => {
  const catalog = {
    'openai/gpt-5.1-mini': {
      id: 'openai/gpt-5.1-mini',
      context_length: 200000,
      max_output_tokens: 16000,
      pricing: { prompt: 0.000001, completion: 0.000004 },
      created_at: '2026-01-01T00:00:00Z',
    },
    'openai/gpt-5.4-mini': {
      id: 'openai/gpt-5.4-mini',
      context_length: 200000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.000001, completion: 0.000004 },
      created_at: '2026-03-01T00:00:00Z',
    },
  };

  const suggestions = buildModelUpgradeSuggestions({
    selectedModels: ['openai:gpt-5.1-mini'],
    synthesizerModel: 'openai:gpt-5.1-mini',
    convergenceModel: '',
    webSearchModel: '',
    modelCatalog: catalog,
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].suggestedModel, 'openai:gpt-5.4-mini');
  assert.deepEqual(suggestions[0].roleLabels, ['Debate roster', 'Synthesis']);
});

runTest('buildConfiguredModelUpgradeTargets assigns per-target policy metadata', () => {
  const debateKey = getModelUpgradeTargetKey('debate', 'openai/gpt-5.1');
  const synthKey = getModelUpgradeTargetKey('synth');
  const targets = buildConfiguredModelUpgradeTargets({
    selectedModels: ['openai/gpt-5.1'],
    synthesizerModel: 'openai/gpt-5.1',
    convergenceModel: '',
    webSearchModel: '',
    policies: {
      [debateKey]: 'auto',
      [synthKey]: 'pinned',
    },
  });

  assert.deepEqual(targets.map((target) => [target.key, target.policy, target.label]), [
    [debateKey, 'auto', 'Debate model 1'],
    [synthKey, 'pinned', 'Synthesis'],
  ]);
});

runTest('buildModelUpgradeSuggestions keeps auto targets active even when the notice was dismissed', () => {
  const catalog = {
    'z-ai/glm-5': {
      id: 'z-ai/glm-5',
      context_length: 128000,
      max_output_tokens: 16000,
      pricing: { prompt: 0.000001, completion: 0.000004 },
      created_at: '2026-01-15T00:00:00Z',
    },
    'z-ai/glm-5.1': {
      id: 'z-ai/glm-5.1',
      context_length: 128000,
      max_output_tokens: 32000,
      pricing: { prompt: 0.000001, completion: 0.000004 },
      created_at: '2026-03-15T00:00:00Z',
    },
  };
  const debateKey = getModelUpgradeTargetKey('debate', 'z-ai/glm-5');
  const synthKey = getModelUpgradeTargetKey('synth');
  const dismissedKey = buildModelUpgradeSuggestionKey('z-ai/glm-5', 'z-ai/glm-5.1');

  const suggestions = buildModelUpgradeSuggestions({
    selectedModels: ['z-ai/glm-5'],
    synthesizerModel: 'z-ai/glm-5',
    convergenceModel: '',
    webSearchModel: '',
    modelCatalog: catalog,
    policies: {
      [debateKey]: 'auto',
      [synthKey]: 'pinned',
    },
    dismissedSuggestionKeys: [dismissedKey],
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].autoTargetCount, 1);
  assert.equal(suggestions[0].notifyTargetCount, 0);
  assert.deepEqual(suggestions[0].targets.map((target) => target.key), [debateKey]);
});

runTest('buildModelUpgradeSuggestions still notifies when the only newer release is unsafe for auto-switching', () => {
  const catalog = {
    'z-ai/glm-5': {
      id: 'z-ai/glm-5',
      context_length: 80_000,
      max_output_tokens: 16_000,
      pricing: { prompt: 0.72, completion: 2.3 },
      created_at: '2026-02-11T00:00:00Z',
    },
    'z-ai/glm-5.1': {
      id: 'z-ai/glm-5.1',
      context_length: 202_752,
      max_output_tokens: 16_000,
      pricing: { prompt: 1.26, completion: 3.96 },
      created_at: '2026-04-07T00:00:00Z',
    },
  };
  const debateKey = getModelUpgradeTargetKey('debate', 'z-ai/glm-5');

  const suggestions = buildModelUpgradeSuggestions({
    selectedModels: ['z-ai/glm-5'],
    synthesizerModel: '',
    convergenceModel: '',
    webSearchModel: '',
    modelCatalog: catalog,
    policies: {
      [debateKey]: 'notify',
    },
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].suggestedModel, 'z-ai/glm-5.1');
  assert.equal(suggestions[0].isSafe, false);
  assert.equal(suggestions[0].autoTargetCount, 0);
  assert.equal(suggestions[0].notifyTargetCount, 1);
  assert.match(suggestions[0].safetyMessage, /pricing is about 73% higher/i);
});

// eslint-disable-next-line no-console
console.log('Model upgrade tests completed.');
