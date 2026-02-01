import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import './CopyButton.css';

export default function CopyButton({ text, className = '' }) {
  const [copied, setCopied] = useState(false);

  if (!text) return null;

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <button
      className={`copy-btn ${copied ? 'copied' : ''} ${className}`}
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
