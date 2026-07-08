import {
  Suspense,
  lazy,
  memo,
  useEffect,
} from "react";

import { cn } from "@/lib/utils";

interface MarkdownTextProps {
  children: string;
  className?: string;
  streaming?: boolean;
}

const loadMarkdownRenderer = () => import("@/components/MarkdownTextRenderer");
const LazyMarkdownRenderer = lazy(loadMarkdownRenderer);

const MemoizedMarkdownRenderer = memo(function MemoizedMarkdownRenderer({
  source,
  className,
  highlightCode,
}: {
  source: string;
  className?: string;
  highlightCode: boolean;
}) {
  return (
    <LazyMarkdownRenderer className={className} highlightCode={highlightCode}>
      {source}
    </LazyMarkdownRenderer>
  );
});

export function preloadMarkdownText(): void {
  void loadMarkdownRenderer();
}

/**
 * Lightweight markdown renderer mirroring agent-chat-ui: GFM + math via
 * ``remark-math`` / ``rehype-katex``, and fenced code blocks delegated to
 * ``CodeBlock`` for copy-to-clipboard and syntax highlighting.
 */
export function MarkdownText({
  children,
  className,
  streaming = false,
}: MarkdownTextProps) {
  const renderedSource = children;
  const highlightCode = !streaming && renderedSource === children;

  useEffect(() => {
    if (streaming) preloadMarkdownText();
  }, [streaming]);

  return (
    <Suspense
      fallback={
        <div
          className={cn(
            "whitespace-pre-wrap break-words leading-relaxed text-foreground/92",
            className,
          )}
        >
          {renderedSource}
        </div>
      }
    >
      <MemoizedMarkdownRenderer
        source={renderedSource}
        className={className}
        highlightCode={highlightCode}
      />
    </Suspense>
  );
}
