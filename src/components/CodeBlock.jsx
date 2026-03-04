import { useEffect, useMemo, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import './CodeBlock.css';

let syntaxHighlighterBundlePromise = null;

function loadSyntaxHighlighterBundle() {
  if (!syntaxHighlighterBundlePromise) {
    syntaxHighlighterBundlePromise = Promise.all([
      import('react-syntax-highlighter'),
      import('react-syntax-highlighter/dist/esm/styles/prism'),
    ])
      .then(([syntaxModule, themeModule]) => {
        const SyntaxHighlighter = syntaxModule.Prism || syntaxModule.default?.Prism;
        const oneDark = themeModule.oneDark || themeModule.default?.oneDark || themeModule.default;
        if (!SyntaxHighlighter || !oneDark) {
          throw new Error('Failed to load syntax highlighter modules');
        }
        return { SyntaxHighlighter, oneDark };
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
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
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
    if (!bundle?.oneDark) return null;
    return {
      ...bundle.oneDark,
      'pre[class*="language-"]': {
        ...bundle.oneDark['pre[class*="language-"]'],
        background: 'rgba(0, 0, 0, 0.4)',
        margin: 0,
        padding: '16px',
        fontSize: '0.85em',
        borderRadius: 0,
      },
      'code[class*="language-"]': {
        ...bundle.oneDark['code[class*="language-"]'],
        background: 'none',
        fontSize: '0.85em',
      },
    };
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
          language={language || 'text'}
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
