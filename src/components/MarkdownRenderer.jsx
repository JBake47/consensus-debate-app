import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

export default function MarkdownRenderer({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children, ...props }) {
          return (
            <CodeBlock inline={inline} className={className} {...props}>
              {children}
            </CodeBlock>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
