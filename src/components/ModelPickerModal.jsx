import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, X } from 'lucide-react';
import { searchModels } from '../lib/openrouter';
import './ModelPickerModal.css';

const PAGE_SIZE = 60;
const TOKEN_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function toFiniteNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getContextLength(model) {
  return (
    toFiniteNumber(model?.context_length) ??
    toFiniteNumber(model?.top_provider?.context_length) ??
    toFiniteNumber(model?.architecture?.context_length) ??
    toFiniteNumber(model?.top_provider?.max_prompt_tokens)
  );
}

function getMaxOutput(model) {
  return (
    toFiniteNumber(model?.top_provider?.max_completion_tokens) ??
    toFiniteNumber(model?.max_completion_tokens) ??
    toFiniteNumber(model?.max_output_tokens) ??
    toFiniteNumber(model?.architecture?.max_completion_tokens)
  );
}

function normalizePricePerMillion(rawValue) {
  const raw = toFiniteNumber(rawValue);
  if (raw == null) return null;
  return raw > 0.01 ? raw : raw * 1_000_000;
}

function formatTokens(value) {
  if (value == null) return 'N/A';
  return TOKEN_FORMATTER.format(value);
}

function formatTokensTitle(value) {
  if (value == null) return 'Unavailable';
  return `${value.toLocaleString()} tokens`;
}

function formatPrice(value) {
  if (value == null) return 'N/A';
  if (value === 0) return '$0/M';
  const digits = value >= 100 ? 0 : value >= 10 ? 2 : value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: digits })}/M`;
}

function formatPriceTitle(value) {
  if (value == null) return 'Unavailable';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} per million tokens`;
}

function getModelStats(model) {
  const pricing = model?.pricing || {};
  const contextLength = getContextLength(model);
  const maxOutput = getMaxOutput(model);
  const inputPrice = normalizePricePerMillion(pricing.prompt ?? pricing.input ?? pricing.input_per_token ?? pricing.prompt_per_token);
  const outputPrice = normalizePricePerMillion(pricing.completion ?? pricing.output ?? pricing.output_per_token ?? pricing.completion_per_token);
  const cacheRead = normalizePricePerMillion(pricing.input_cache_read ?? pricing.cache_read);
  const cacheWrite = normalizePricePerMillion(pricing.input_cache_write ?? pricing.cache_write);

  return [
    {
      label: 'Context',
      value: formatTokens(contextLength),
      title: `Total Context: ${formatTokensTitle(contextLength)}`,
    },
    {
      label: 'Max',
      value: formatTokens(maxOutput),
      title: `Max Output: ${formatTokensTitle(maxOutput)}`,
    },
    {
      label: 'In / Out',
      value: `${formatPrice(inputPrice)} / ${formatPrice(outputPrice)}`,
      title: `Input Price: ${formatPriceTitle(inputPrice)} | Output Price: ${formatPriceTitle(outputPrice)}`,
    },
    {
      label: 'Cache R / W',
      value: `${formatPrice(cacheRead)} / ${formatPrice(cacheWrite)}`,
      title: `Cache Read: ${formatPriceTitle(cacheRead)} | Cache Write: ${formatPriceTitle(cacheWrite)}`,
    },
  ];
}

export default function ModelPickerModal({ open, onClose, onAdd, provider = 'openrouter', apiKey = '' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setTotal(0);
    setPage(0);
    setError('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const providerFilter = provider === 'openrouter' ? '' : (provider === 'gemini' ? 'google' : provider);
    searchModels({ query, provider: providerFilter, limit: PAGE_SIZE, offset: page * PAGE_SIZE, apiKey })
      .then((data) => {
        if (cancelled) return;
        setResults(data.data || []);
        setTotal(data.total || 0);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load models');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, query, page, apiKey, provider]);

  const pageCount = useMemo(() => {
    if (!total) return 1;
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
  }, [total]);

  if (!open) return null;

  const titleSuffix = provider === 'openrouter' ? 'OpenRouter' : provider[0].toUpperCase() + provider.slice(1);
  const formatModelId = (id) => {
    if (!id) return '';
    if (provider === 'openrouter') return id;
    const parts = id.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : id;
  };

  return (
    <div className="model-picker-overlay" onClick={onClose}>
      <div className="model-picker-modal glass-panel" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-header">
          <h3>Browse {titleSuffix} Models</h3>
          <button className="model-picker-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="model-picker-search">
          <Search size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder="Search by model id or name..."
          />
        </div>
        <div className="model-picker-body">
          {loading && <div className="model-picker-status">Loading models...</div>}
          {!loading && error && <div className="model-picker-status error">{error}</div>}
          {!loading && !error && results.length === 0 && (
            <div className="model-picker-status">No models found.</div>
          )}
          {!loading && !error && results.length > 0 && (
            <div className="model-picker-list">
              {results.map((model) => {
                const stats = getModelStats(model);
                return (
                  <div key={model.id} className="model-picker-item">
                    <div className="model-picker-info">
                      <div className="model-picker-name">{formatModelId(model.id)}</div>
                      <div className="model-picker-desc">
                        {provider === 'openrouter' ? model.name || model.id : model.id}
                      </div>
                      <div className="model-picker-stats">
                        {stats.map((stat) => (
                          <div key={stat.label} className="model-picker-stat" title={stat.title}>
                            <span className="model-picker-stat-label">{stat.label}</span>
                            <span className="model-picker-stat-value">{stat.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <button className="model-picker-add" onClick={() => onAdd(model.id)}>
                      <Plus size={14} />
                      Add
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="model-picker-footer">
          <span className="model-picker-count">{total} models</span>
          <div className="model-picker-pagination">
            <button
              className="model-picker-page"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              Prev
            </button>
            <span>{page + 1} / {pageCount}</span>
            <button
              className="model-picker-page"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
