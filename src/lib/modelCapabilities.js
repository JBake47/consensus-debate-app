function normalizeModalities(modalities) {
  if (!modalities) return [];
  if (Array.isArray(modalities)) {
    return modalities.filter(Boolean).map(m => String(m).toLowerCase());
  }
  if (typeof modalities === 'string') {
    return modalities
      .split(',')
      .map(m => m.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function collectModalities(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') return [];
  const candidates = [
    modelInfo.modalities,
    modelInfo.input_modalities,
    modelInfo.inputModalities,
    modelInfo.supported_modalities,
    modelInfo.supportedModalities,
    modelInfo.modality,
    modelInfo.architecture?.modalities,
    modelInfo.architecture?.input_modalities,
    modelInfo.architecture?.inputModalities,
    modelInfo.architecture?.modality,
    modelInfo.capabilities?.modalities,
    modelInfo.capabilities?.input_modalities,
    modelInfo.capabilities?.inputModalities,
  ];

  return candidates.flatMap(normalizeModalities);
}

export function getModelImageSupport(modelInfo) {
  const modalities = collectModalities(modelInfo);
  if (modalities.length === 0) return null;
  const supportsImages = modalities.some(modality =>
    modality.includes('image') || modality.includes('vision') || modality.includes('multimodal')
  );
  return supportsImages;
}

export function getImageIncompatibleModels(modelIds, modelCatalog) {
  if (!Array.isArray(modelIds) || !modelCatalog) return [];
  return modelIds.filter(modelId => {
    const modelInfo = modelCatalog[modelId];
    const supportsImages = getModelImageSupport(modelInfo);
    return supportsImages === false;
  });
}
