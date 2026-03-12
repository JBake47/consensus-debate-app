const TOKEN_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function toFiniteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getCatalogModelLookupId(modelId) {
  const trimmed = String(modelId || '').trim();
  if (!trimmed) return '';

  if (trimmed.includes(':')) {
    const [prefixRaw, ...restParts] = trimmed.split(':');
    const rest = restParts.join(':').trim();
    if (!rest) return trimmed;
    const prefix = prefixRaw.toLowerCase();
    const normalizedPrefix = prefix === 'gemini' ? 'google' : prefix;
    return `${normalizedPrefix}/${rest}`;
  }

  return trimmed;
}

export function resolveModelCatalogEntry(modelCatalog = {}, modelId) {
  const catalogId = getCatalogModelLookupId(modelId);
  return {
    catalogId,
    model: catalogId ? modelCatalog?.[catalogId] || null : null,
  };
}

export function getContextLength(model) {
  return (
    toFiniteNumber(model?.context_length) ??
    toFiniteNumber(model?.contextWindow) ??
    toFiniteNumber(model?.top_provider?.context_length) ??
    toFiniteNumber(model?.architecture?.context_length) ??
    toFiniteNumber(model?.top_provider?.max_prompt_tokens)
  );
}

export function getMaxOutput(model) {
  return (
    toFiniteNumber(model?.top_provider?.max_completion_tokens) ??
    toFiniteNumber(model?.max_completion_tokens) ??
    toFiniteNumber(model?.max_output_tokens) ??
    toFiniteNumber(model?.architecture?.max_completion_tokens)
  );
}

export function normalizePricePerMillion(rawValue) {
  const raw = toFiniteNumber(rawValue);
  if (raw == null) return null;
  return raw > 0.01 ? raw : raw * 1_000_000;
}

export function getModelStatSnapshot(model = {}) {
  const pricing = model?.pricing || {};

  return {
    contextLength: getContextLength(model),
    maxOutput: getMaxOutput(model),
    inputPrice: normalizePricePerMillion(
      pricing.prompt ?? pricing.input ?? pricing.input_per_token ?? pricing.prompt_per_token
    ),
    outputPrice: normalizePricePerMillion(
      pricing.completion ?? pricing.output ?? pricing.output_per_token ?? pricing.completion_per_token
    ),
    cacheRead: normalizePricePerMillion(pricing.input_cache_read ?? pricing.cache_read),
    cacheWrite: normalizePricePerMillion(pricing.input_cache_write ?? pricing.cache_write),
  };
}

export function formatTokenQuantity(value, { detailed = false } = {}) {
  if (value == null) return detailed ? 'Unavailable' : 'N/A';
  if (detailed) return `${value.toLocaleString()} tokens`;
  return TOKEN_FORMATTER.format(value);
}

export function formatPricePerMillion(value, { detailed = false } = {}) {
  if (value == null) return detailed ? 'Unavailable' : 'N/A';
  if (value === 0) return detailed ? '$0 per million tokens' : '$0/M';

  const digits = detailed
    ? 6
    : value >= 100
      ? 0
      : value >= 10
        ? 2
        : value >= 1
          ? 2
          : value >= 0.01
            ? 3
            : 4;
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: digits });
  return detailed ? `$${formatted} per million tokens` : `$${formatted}/M`;
}

export function getModelStatRows(model = {}) {
  const stats = getModelStatSnapshot(model);
  return [
    {
      key: 'contextLength',
      label: 'Total Context',
      value: formatTokenQuantity(stats.contextLength),
      detail: formatTokenQuantity(stats.contextLength, { detailed: true }),
    },
    {
      key: 'maxOutput',
      label: 'Max Output',
      value: formatTokenQuantity(stats.maxOutput),
      detail: formatTokenQuantity(stats.maxOutput, { detailed: true }),
    },
    {
      key: 'inputPrice',
      label: 'Input Price',
      value: formatPricePerMillion(stats.inputPrice),
      detail: formatPricePerMillion(stats.inputPrice, { detailed: true }),
    },
    {
      key: 'outputPrice',
      label: 'Output Price',
      value: formatPricePerMillion(stats.outputPrice),
      detail: formatPricePerMillion(stats.outputPrice, { detailed: true }),
    },
    {
      key: 'cacheRead',
      label: 'Cache Read',
      value: formatPricePerMillion(stats.cacheRead),
      detail: formatPricePerMillion(stats.cacheRead, { detailed: true }),
    },
    {
      key: 'cacheWrite',
      label: 'Cache Write',
      value: formatPricePerMillion(stats.cacheWrite),
      detail: formatPricePerMillion(stats.cacheWrite, { detailed: true }),
    },
  ];
}

export function getModelStatsUnavailableMessage(modelCatalogStatus = 'idle') {
  if (modelCatalogStatus === 'loading') return 'Loading model stats...';
  if (modelCatalogStatus === 'error') return 'Model stats unavailable because the catalog failed to load.';
  return 'Model stats unavailable for this model in the current catalog.';
}

export function buildModelStatsTitle({
  modelId,
  modelCatalog = {},
  modelCatalogStatus = 'idle',
} = {}) {
  const trimmed = String(modelId || '').trim();
  if (!trimmed) return '';

  const { model } = resolveModelCatalogEntry(modelCatalog, trimmed);
  const lines = [];
  const displayName = String(model?.name || '').trim();

  if (displayName && displayName.toLowerCase() !== trimmed.toLowerCase()) {
    lines.push(displayName);
  }
  lines.push(trimmed);

  if (!model) {
    lines.push(getModelStatsUnavailableMessage(modelCatalogStatus));
    return lines.join('\n');
  }

  for (const row of getModelStatRows(model)) {
    lines.push(`${row.label}: ${row.detail}`);
  }

  return lines.join('\n');
}
