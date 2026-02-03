import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, X } from 'lucide-react';
import { searchModels } from '../lib/openrouter';
import './ModelPickerModal.css';

const PAGE_SIZE = 60;

export default function ModelPickerModal({ open, onClose, onAdd, provider = 'openrouter' }) {
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
    searchModels({ query, provider: providerFilter, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
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
  }, [open, query, page]);

  const pageCount = useMemo(() => {
    if (!total) return 1;
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
  }, [total]);

  if (!open) return null;

  const titleSuffix = provider === 'openrouter' ? 'OpenRouter' : provider[0].toUpperCase() + provider.slice(1);

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
              {results.map((model) => (
                <div key={model.id} className="model-picker-item">
                  <div className="model-picker-info">
                    <div className="model-picker-name">{model.id}</div>
                    {model.name && <div className="model-picker-desc">{model.name}</div>}
                  </div>
                  <button className="model-picker-add" onClick={() => onAdd(model.id)}>
                    <Plus size={14} />
                    Add
                  </button>
                </div>
              ))}
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
