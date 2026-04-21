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
