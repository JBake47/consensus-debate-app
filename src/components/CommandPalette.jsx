import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, Search } from 'lucide-react';
import './CommandPalette.css';

export default function CommandPalette({
  open,
  commands = [],
  onClose,
}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return commands;
    return commands.filter((command) => {
      const title = String(command.title || '').toLowerCase();
      const keywords = String(command.keywords || '').toLowerCase();
      return title.includes(trimmed) || keywords.includes(trimmed);
    });
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, Math.max(0, filtered.length - 1)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        if (filtered.length === 0) return;
        event.preventDefault();
        filtered[selectedIndex]?.run?.();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, filtered, selectedIndex, onClose]);

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={() => onClose?.()}>
      <div className="command-palette" onClick={(event) => event.stopPropagation()}>
        <div className="command-palette-search">
          <Search size={14} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a command..."
          />
          <div className="command-palette-hint">
            <Command size={11} />
            <span>K</span>
          </div>
        </div>
        <div className="command-palette-list">
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No commands found.</div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id || command.title || index}
                className={`command-palette-item ${index === selectedIndex ? 'selected' : ''}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => {
                  command.run?.();
                  onClose?.();
                }}
              >
                <div className="command-palette-item-left">
                  {command.icon || null}
                  <span>{command.title}</span>
                </div>
                {command.shortcut && (
                  <span className="command-palette-shortcut">{command.shortcut}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
