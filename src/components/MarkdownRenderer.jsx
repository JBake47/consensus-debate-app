import { lazy, memo, Suspense } from 'react';

const MarkdownContent = lazy(() => import('./MarkdownContent'));

function MarkdownRenderer({ children }) {
  const fallbackText = typeof children === 'string' ? children : '';

  return (
    <Suspense fallback={fallbackText}>
      <MarkdownContent>{children}</MarkdownContent>
    </Suspense>
  );
}

export default memo(
  MarkdownRenderer,
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);
