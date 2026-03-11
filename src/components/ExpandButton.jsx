import { Maximize2 } from 'lucide-react';
import './ExpandButton.css';

export default function ExpandButton({ onClick, title = 'Expand response', className = '' }) {
  return (
    <button
      className={`expand-btn ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      title={title}
      aria-label={title}
      type="button"
    >
      <Maximize2 size={13} />
    </button>
  );
}
