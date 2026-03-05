import { useEffect, useMemo, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import './CodeBlock.css';

let syntaxHighlighterBundlePromise = null;
const CODE_THEME = {
  'pre[class*="language-"]': {
    background: 'rgba(0, 0, 0, 0.4)',
    color: '#e5eef9',
    margin: 0,
    padding: '16px',
    fontSize: '0.85em',
    borderRadius: 0,
  },
  'code[class*="language-"]': {
    background: 'none',
    color: '#e5eef9',
    fontSize: '0.85em',
    textShadow: 'none',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)',
  },
  comment: { color: '#7f8ea3', fontStyle: 'italic' },
  prolog: { color: '#7f8ea3' },
  doctype: { color: '#7f8ea3' },
  cdata: { color: '#7f8ea3' },
  punctuation: { color: '#9fb3c8' },
  property: { color: '#7dd3fc' },
  tag: { color: '#fda4af' },
  boolean: { color: '#f9a8d4' },
  number: { color: '#f9a8d4' },
  constant: { color: '#f9a8d4' },
  symbol: { color: '#f9a8d4' },
  deleted: { color: '#f9a8d4' },
  selector: { color: '#86efac' },
  'attr-name': { color: '#86efac' },
  string: { color: '#86efac' },
  char: { color: '#86efac' },
  builtin: { color: '#86efac' },
  inserted: { color: '#86efac' },
  operator: { color: '#f5d08a' },
  entity: { color: '#f5d08a', cursor: 'help' },
  url: { color: '#f5d08a' },
  atrule: { color: '#c4b5fd' },
  'attr-value': { color: '#c4b5fd' },
  keyword: { color: '#c4b5fd' },
  function: { color: '#93c5fd' },
  'class-name': { color: '#fde68a' },
  regex: { color: '#fdba74' },
  important: { color: '#fdba74', fontWeight: '600' },
  variable: { color: '#fca5a5' },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
};
const LANGUAGE_ALIASES = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  csharp: 'csharp',
  cs: 'csharp',
  cpp: 'cpp',
  html: 'markup',
  xml: 'markup',
};

function loadSyntaxHighlighterBundle() {
  if (!syntaxHighlighterBundlePromise) {
    syntaxHighlighterBundlePromise = import('react-syntax-highlighter/dist/esm/prism-async-light')
      .then((syntaxModule) => {
        const SyntaxHighlighter = syntaxModule.default || syntaxModule.PrismAsyncLight;
        if (!SyntaxHighlighter) {
          throw new Error('Failed to load syntax highlighter modules');
        }
        return { SyntaxHighlighter };
      })
      .catch((err) => {
        syntaxHighlighterBundlePromise = null;
        throw err;
      });
  }
  return syntaxHighlighterBundlePromise;
}

export default function CodeBlock({ children, className, inline }) {
  const [copied, setCopied] = useState(false);
  const [bundle, setBundle] = useState(null);
  const match = /language-([A-Za-z0-9_+#-]+)/.exec(className || '');
  const language = match ? match[1].toLowerCase() : '';
  const resolvedLanguage = LANGUAGE_ALIASES[language] || language || 'text';
  const code = String(children).replace(/\n$/, '');

  useEffect(() => {
    if (inline) return undefined;
    let cancelled = false;
    loadSyntaxHighlighterBundle()
      .then((nextBundle) => {
        if (!cancelled) setBundle(nextBundle);
      })
      .catch(() => {
        if (!cancelled) setBundle({ failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [inline]);

  const customTheme = useMemo(() => {
    if (!bundle?.SyntaxHighlighter) return null;
    return CODE_THEME;
  }, [bundle]);

  if (inline) {
    return <code className="inline-code">{children}</code>;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };
  const SyntaxHighlighterComponent = bundle?.SyntaxHighlighter || null;

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language || 'text'}</span>
        <button className="code-block-copy" onClick={handleCopy} title="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {SyntaxHighlighterComponent && customTheme ? (
        <SyntaxHighlighterComponent
          style={customTheme}
          language={resolvedLanguage}
          PreTag="div"
          wrapLongLines
        >
          {code}
        </SyntaxHighlighterComponent>
      ) : (
        <pre className="code-block-fallback">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
