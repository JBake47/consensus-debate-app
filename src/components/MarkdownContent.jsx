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

export default function MarkdownContent({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
}
