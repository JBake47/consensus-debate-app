export function presetMatchesDraft(preset, draft) {
  if (!preset || !draft) return false;
  const presetModels = Array.isArray(preset.models) ? preset.models : [];
  const draftModels = Array.isArray(draft.models) ? draft.models : [];
  if (presetModels.length !== draftModels.length) return false;
  for (let index = 0; index < presetModels.length; index += 1) {
    if (presetModels[index] !== draftModels[index]) return false;
  }
  return (
    String(preset.synthesizerModel || '') === String(draft.synthesizerModel || '')
    && String(preset.convergenceModel || '') === String(draft.convergenceModel || '')
    && String(preset.webSearchModel || '') === String(draft.webSearchModel || '')
    && Number(preset.maxDebateRounds || 0) === Number(draft.maxDebateRounds || 0)
  );
}

export function presetModelRosterMatchesDraft(preset, draft) {
  if (!preset || !draft) return false;
  const presetModels = Array.isArray(preset.models) ? preset.models : [];
  const draftModels = Array.isArray(draft.models) ? draft.models : [];
  if (presetModels.length !== draftModels.length) return false;
  for (let index = 0; index < presetModels.length; index += 1) {
    if (presetModels[index] !== draftModels[index]) return false;
  }
  return presetModels.length > 0;
}

export function buildUniquePresetName(baseName, presets, excludeId = null) {
  const root = String(baseName || 'New Preset').trim() || 'New Preset';
  const existing = new Set(
    (presets || [])
      .filter((preset) => preset?.id !== excludeId)
      .map((preset) => String(preset?.name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (!existing.has(root.toLowerCase())) return root;
  let index = 2;
  let candidate = `${root} ${index}`;
  while (existing.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${root} ${index}`;
  }
  return candidate;
}

export function resolvePresetSelection({
  currentPresetId = '',
  initialized = false,
  modelPresets = [],
  rememberedPresetId = '',
  savedSettingsSnapshot = null,
} = {}) {
  const presets = Array.isArray(modelPresets) ? modelPresets : [];
  const presetExists = (presetId) => Boolean(
    presetId && presets.some((preset) => preset?.id === presetId)
  );

  if (initialized) {
    if (!currentPresetId || presetExists(currentPresetId)) return currentPresetId || '';
    return presetExists(rememberedPresetId) ? rememberedPresetId : '';
  }

  if (presetExists(currentPresetId)) return currentPresetId;
  if (presetExists(rememberedPresetId)) return rememberedPresetId;

  const exactMatch = presets.find((preset) => presetMatchesDraft(preset, savedSettingsSnapshot));
  if (exactMatch?.id) return exactMatch.id;

  const rosterMatch = presets.find((preset) => presetModelRosterMatchesDraft(preset, savedSettingsSnapshot));
  return rosterMatch?.id || '';
}

const MODEL_PRESET_EXPORT_KIND = 'consensus.modelPresets';
const MODEL_PRESET_EXPORT_VERSION = 1;

function normalizePresetString(value) {
  return String(value || '').trim();
}

function normalizePresetModels(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map((modelId) => normalizePresetString(modelId))
    .filter((modelId) => {
      if (!modelId || seen.has(modelId)) return false;
      seen.add(modelId);
      return true;
    });
}

export function normalizeModelPresetForTransfer(value) {
  if (!value || typeof value !== 'object') return null;

  const name = normalizePresetString(value.name);
  const models = normalizePresetModels(value.models);
  const synthesizerModel = normalizePresetString(value.synthesizerModel);
  const convergenceModel = normalizePresetString(value.convergenceModel);
  const webSearchModel = normalizePresetString(value.webSearchModel);
  const maxDebateRounds = Number(value.maxDebateRounds);

  if (
    !name
    || models.length === 0
    || !synthesizerModel
    || !convergenceModel
    || !webSearchModel
    || !Number.isFinite(maxDebateRounds)
  ) {
    return null;
  }

  return {
    name,
    models,
    synthesizerModel,
    convergenceModel,
    maxDebateRounds: Math.max(1, Math.min(10, Math.round(maxDebateRounds))),
    webSearchModel,
  };
}

function getPresetImportEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.presets)) return value.presets;
  if (Array.isArray(value.modelPresets)) return value.modelPresets;
  if (Array.isArray(value.models)) return [value];
  return [];
}

export function buildModelPresetExportPayload(modelPresets, { exportedAt = new Date().toISOString() } = {}) {
  const presets = (Array.isArray(modelPresets) ? modelPresets : [])
    .map((preset) => normalizeModelPresetForTransfer(preset))
    .filter(Boolean);

  return {
    kind: MODEL_PRESET_EXPORT_KIND,
    version: MODEL_PRESET_EXPORT_VERSION,
    exportedAt,
    presets,
  };
}

export function serializeModelPresetExport(modelPresets, options = {}) {
  return JSON.stringify(buildModelPresetExportPayload(modelPresets, options), null, 2);
}

export function parseModelPresetImportText(text, { existingPresets = [] } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    throw new Error('Failed to parse file. Use a valid JSON preset export.');
  }

  const entries = getPresetImportEntries(parsed);
  if (entries.length === 0) {
    throw new Error('No model presets were found in this file.');
  }

  const imported = [];
  let skippedCount = 0;
  let renamedCount = 0;

  entries.forEach((entry) => {
    const normalized = normalizeModelPresetForTransfer(entry);
    if (!normalized) {
      skippedCount += 1;
      return;
    }

    const uniqueName = buildUniquePresetName(normalized.name, [
      ...(Array.isArray(existingPresets) ? existingPresets : []),
      ...imported,
    ]);

    if (uniqueName !== normalized.name) renamedCount += 1;
    imported.push({ ...normalized, name: uniqueName });
  });

  return {
    presets: imported,
    totalCount: entries.length,
    skippedCount,
    renamedCount,
  };
}
