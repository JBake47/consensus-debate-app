import assert from 'node:assert/strict';
import {
  buildUniquePresetName,
  presetMatchesDraft,
  presetModelRosterMatchesDraft,
  resolvePresetSelection,
} from './modelPresets.js';

const savedSnapshot = {
  models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.5'],
  synthesizerModel: 'openai/gpt-5.4',
  convergenceModel: 'openai/gpt-5.4-mini',
  maxDebateRounds: 3,
  webSearchModel: 'openai/gpt-5.4-mini',
};

const exactPreset = {
  id: 'exact',
  name: 'Exact',
  ...savedSnapshot,
};

const sameRosterPreset = {
  id: 'same-roster',
  name: 'Same Roster',
  ...savedSnapshot,
  synthesizerModel: 'anthropic/claude-sonnet-4.5',
  maxDebateRounds: 4,
};

const otherPreset = {
  id: 'other',
  name: 'Other',
  ...savedSnapshot,
  models: ['google/gemini-3-pro'],
};

assert.equal(presetMatchesDraft(exactPreset, savedSnapshot), true);
assert.equal(presetMatchesDraft(sameRosterPreset, savedSnapshot), false);
assert.equal(presetModelRosterMatchesDraft(sameRosterPreset, savedSnapshot), true);
assert.equal(
  presetModelRosterMatchesDraft({ ...sameRosterPreset, models: [] }, { ...savedSnapshot, models: [] }),
  false,
);

assert.equal(
  buildUniquePresetName(' Research ', [{ id: 'a', name: 'research' }, { id: 'b', name: 'Research 2' }]),
  'Research 3',
);
assert.equal(
  buildUniquePresetName('Research', [{ id: 'a', name: 'Research' }], 'a'),
  'Research',
);

assert.equal(
  resolvePresetSelection({
    currentPresetId: 'other',
    modelPresets: [exactPreset, otherPreset],
    rememberedPresetId: 'exact',
    savedSettingsSnapshot: savedSnapshot,
  }),
  'other',
  'existing current selection should win during first initialization',
);

assert.equal(
  resolvePresetSelection({
    modelPresets: [exactPreset],
    rememberedPresetId: 'exact',
    savedSettingsSnapshot: savedSnapshot,
  }),
  'exact',
  'remembered explicit preset should win before value matching',
);

assert.equal(
  resolvePresetSelection({
    modelPresets: [exactPreset],
    rememberedPresetId: 'missing',
    savedSettingsSnapshot: savedSnapshot,
  }),
  'exact',
  'first open should recover an exact preset match when no remembered preset exists',
);

assert.equal(
  resolvePresetSelection({
    modelPresets: [sameRosterPreset],
    savedSettingsSnapshot: savedSnapshot,
  }),
  'same-roster',
  'first open should recover the same debate roster even when supporting settings changed',
);

assert.equal(
  resolvePresetSelection({
    currentPresetId: '',
    initialized: true,
    modelPresets: [exactPreset],
    rememberedPresetId: 'exact',
    savedSettingsSnapshot: savedSnapshot,
  }),
  '',
  'manual new-draft mode should remain blank after initialization',
);

assert.equal(
  resolvePresetSelection({
    currentPresetId: 'deleted',
    initialized: true,
    modelPresets: [exactPreset],
    rememberedPresetId: 'exact',
    savedSettingsSnapshot: savedSnapshot,
  }),
  'exact',
  'deleted selected preset should fall back to a remembered preset while initialized',
);

assert.equal(
  resolvePresetSelection({
    currentPresetId: 'deleted',
    initialized: true,
    modelPresets: [exactPreset],
    rememberedPresetId: 'deleted',
    savedSettingsSnapshot: savedSnapshot,
  }),
  '',
  'deleted selected preset should not auto-match by values after initialization',
);

console.log('modelPresets tests passed');
