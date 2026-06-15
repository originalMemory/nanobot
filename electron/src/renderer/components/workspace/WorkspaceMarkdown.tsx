import { useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "@/components/CodeBlock";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkBreaks, remarkGfm];

interface WorkspaceMarkdownProps {
  children: string;
  className?: string;
}

/** 工作区浏览专用轻量 Markdown，不加载 KaTeX。 */
export function WorkspaceMarkdown({ children, className }: WorkspaceMarkdownProps) {
  const components = useMemo<Components>(
    () => ({
      code({ className: cls, children: kids, ...props }) {
        const match = /language-(\w+)/.exec(cls || "");
        if (match) {
          const code = String(kids).replace(/\n$/, "");
          return <CodeBlock language={match[1]} code={code} className="my-3" />;
        }
        return (
          <code
            className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", cls)}
            {...props}
          >
            {kids}
          </code>
        );
      },
      pre({ children: markdownChildren }) {
        return (
          <pre className="my-3 overflow-x-auto rounded-lg border border-border/60 bg-muted/35 p-3 font-mono text-[0.8125rem] leading-snug">
            {markdownChildren}
          </pre>
        );
      },
      a({ href, children: markdownChildren, ...props }) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline underline-offset-2 hover:opacity-80"
            {...props}
          >
            {markdownChildren}
          </a>
        );
      },
    }),
    [],
  );

  return (
    <div
      className={cn(
        "markdown-content prose max-w-none dark:prose-invert",
        "prose-headings:font-semibold prose-p:my-2",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
