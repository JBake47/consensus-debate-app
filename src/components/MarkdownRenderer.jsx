import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
  code({ inline, className, children, ...props }) {
    return (
      <CodeBlock inline={inline} className={className} {...props}>
        {children}
      </CodeBlock>
    );
  },
};

function MarkdownRenderer({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
}

export default memo(
  MarkdownRenderer,
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);
