import assert from 'node:assert/strict';
import {
  buildModelPresetExportPayload,
  buildUniquePresetName,
  normalizeModelPresetForTransfer,
  parseModelPresetImportText,
  presetMatchesDraft,
  presetModelRosterMatchesDraft,
  resolvePresetSelection,
  serializeModelPresetExport,
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

assert.deepEqual(
  normalizeModelPresetForTransfer({
    ...exactPreset,
    models: [' openai/gpt-5.4 ', 'openai/gpt-5.4', '', 'anthropic/claude-sonnet-4.5'],
    maxDebateRounds: 99,
  }),
  {
    name: 'Exact',
    models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.5'],
    synthesizerModel: 'openai/gpt-5.4',
    convergenceModel: 'openai/gpt-5.4-mini',
    maxDebateRounds: 10,
    webSearchModel: 'openai/gpt-5.4-mini',
  },
  'transfer normalization trims, dedupes, and clamps imported settings',
);

assert.equal(
  normalizeModelPresetForTransfer({ name: 'Incomplete', models: ['openai/gpt-5.4'] }),
  null,
  'transfer normalization rejects partial presets instead of filling from current settings',
);

const exportPayload = buildModelPresetExportPayload([exactPreset, { name: 'Broken' }], {
  exportedAt: '2026-04-21T00:00:00.000Z',
});
assert.deepEqual(
  exportPayload,
  {
    kind: 'consensus.modelPresets',
    version: 1,
    exportedAt: '2026-04-21T00:00:00.000Z',
    presets: [{
      name: 'Exact',
      models: savedSnapshot.models,
      synthesizerModel: savedSnapshot.synthesizerModel,
      convergenceModel: savedSnapshot.convergenceModel,
      maxDebateRounds: savedSnapshot.maxDebateRounds,
      webSearchModel: savedSnapshot.webSearchModel,
    }],
  },
  'export payload uses an app-owned envelope and omits invalid presets',
);

const roundTrip = parseModelPresetImportText(serializeModelPresetExport([exactPreset]), {
  existingPresets: [{ id: 'existing', name: 'Exact' }],
});
assert.equal(roundTrip.presets.length, 1);
assert.equal(roundTrip.presets[0].name, 'Exact 2');
assert.equal(roundTrip.renamedCount, 1);
assert.equal(roundTrip.skippedCount, 0);

const duplicateImport = parseModelPresetImportText(JSON.stringify({
  presets: [exactPreset, { ...sameRosterPreset, name: 'Exact' }, { name: 'Broken' }],
}), {
  existingPresets: [{ id: 'existing', name: 'Exact' }],
});
assert.equal(duplicateImport.presets.length, 2);
assert.deepEqual(duplicateImport.presets.map((preset) => preset.name), ['Exact 2', 'Exact 3']);
assert.equal(duplicateImport.renamedCount, 2);
assert.equal(duplicateImport.skippedCount, 1);

const legacyImport = parseModelPresetImportText(JSON.stringify({
  modelPresets: [sameRosterPreset],
}));
assert.equal(legacyImport.presets[0].name, 'Same Roster');

const singlePresetImport = parseModelPresetImportText(JSON.stringify(exactPreset));
assert.equal(singlePresetImport.presets.length, 1);

assert.throws(
  () => parseModelPresetImportText('{'),
  /valid JSON preset export/,
);
assert.throws(
  () => parseModelPresetImportText(JSON.stringify({ conversations: [] })),
  /No model presets/,
);

console.log('modelPresets tests passed');
