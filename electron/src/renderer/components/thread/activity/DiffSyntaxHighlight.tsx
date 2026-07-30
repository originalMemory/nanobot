import { lazy, Suspense, type ReactNode } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";

import { isDarkTheme, useThemeValue } from "@/hooks/useTheme";
import type { RenderableFileDiffLine } from "@/lib/file-diff";
import { cn } from "@/lib/utils";

interface DiffSyntaxHighlightProps {
  language: string;
  lines: RenderableFileDiffLine[];
}

interface LoadedDiffSyntaxHighlightProps extends DiffSyntaxHighlightProps {
  dark: boolean;
}

type RendererArgs = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0];
type SyntaxNode = RendererArgs["rows"][number];

const CODE_FONT_STACK = [
  '"JetBrains Mono"',
  '"SFMono-Regular"',
  '"SF Mono"',
  '"Fira Code"',
  '"Cascadia Code"',
  '"Source Code Pro"',
  "Menlo",
  "Consolas",
  "monospace",
].join(", ");

const LazyHighlightedDiff = lazy(async () => {
  const [
    { default: SyntaxHighlighter },
    { default: createSyntaxElement },
    { default: oneDark },
    { default: oneLight },
  ] = await Promise.all([
    import("react-syntax-highlighter/dist/esm/prism-async-light"),
    import("react-syntax-highlighter/dist/esm/create-element"),
    import("react-syntax-highlighter/dist/esm/styles/prism/one-dark"),
    import("react-syntax-highlighter/dist/esm/styles/prism/one-light"),
  ]);
  return {
    default: function HighlightedDiff({
      language,
      lines,
      dark,
    }: LoadedDiffSyntaxHighlightProps) {
      const code = lines.map((line) => line.content || " ").join("\n");
      return (
        <SyntaxHighlighter
          language={language}
          style={dark ? oneDark : oneLight}
          PreTag="div"
          CodeTag="div"
          customStyle={{
            background: "transparent",
            margin: 0,
            padding: 0,
            overflow: "visible",
            fontFamily: CODE_FONT_STACK,
            fontSize: "11px",
            lineHeight: "1.25rem",
          }}
          codeTagProps={{
            style: {
              background: "transparent",
              fontFamily: CODE_FONT_STACK,
            },
          }}
          data-language={language}
          data-testid="syntax-highlighted-diff-hunk"
          renderer={({ rows, stylesheet, useInlineStyles }) => (
            <DiffTable
              lines={lines}
              renderCode={(line, index) => {
                const node = rows[index];
                if (!node) return line.content || " ";
                return createSyntaxElement({
                  node: stripConflictingTableClass(trimTrailingLineBreak(node)),
                  stylesheet,
                  useInlineStyles,
                  key: `diff-code-${index}`,
                });
              }}
            />
          )}
        >
          {code}
        </SyntaxHighlighter>
      );
    },
  };
});

export function DiffSyntaxHighlight({ language, lines }: DiffSyntaxHighlightProps) {
  const dark = isDarkTheme(useThemeValue());
  return (
    <Suspense fallback={<PlainDiffLines lines={lines} />}>
      <LazyHighlightedDiff language={language} lines={lines} dark={dark} />
    </Suspense>
  );
}

function PlainDiffLines({ lines }: { lines: RenderableFileDiffLine[] }) {
  return (
    <div data-testid="plain-diff-hunk">
      <DiffTable lines={lines} renderCode={(line) => line.content || " "} />
    </div>
  );
}

function DiffTable({
  lines,
  renderCode,
}: {
  lines: RenderableFileDiffLine[];
  renderCode: (line: RenderableFileDiffLine, index: number) => ReactNode;
}) {
  return (
    <table className="w-full border-collapse font-mono text-[11px] leading-5">
      <tbody>
        {lines.map((line, index) => (
          <tr
            key={`${line.old_lineno ?? ""}:${line.new_lineno ?? ""}:${index}`}
            className={cn(
              "border-0",
              line.kind === "add" && "bg-emerald-500/[0.10]",
              line.kind === "delete" && "bg-rose-500/[0.10]",
            )}
          >
            <td className="w-9 select-none border-r border-border/35 px-1 text-right text-muted-foreground/55">
              {line.old_lineno ?? ""}
            </td>
            <td className="w-9 select-none border-r border-border/35 px-1 text-right text-muted-foreground/55">
              {line.new_lineno ?? ""}
            </td>
            <td
              className={cn(
                "w-5 select-none px-1 text-center",
                line.kind === "add" && "text-emerald-500",
                line.kind === "delete" && "text-rose-500",
                line.kind === "context" && "text-muted-foreground/45",
              )}
            >
              {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}
            </td>
            <td className="min-w-[16rem] px-1.5">
              <span className="whitespace-pre">{renderCode(line, index)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function trimTrailingLineBreak(node: SyntaxNode): SyntaxNode {
  if (node.type === "text" && typeof node.value === "string") {
    return { ...node, value: node.value.replace(/\n$/, "") };
  }
  if (!node.children?.length) return node;
  const children = [...node.children];
  children[children.length - 1] = trimTrailingLineBreak(children[children.length - 1]!);
  return { ...node, children };
}

function stripConflictingTableClass(node: SyntaxNode): SyntaxNode {
  const className = node.properties?.className;
  const children = node.children?.map(stripConflictingTableClass);
  const hasTableClass = Array.isArray(className) && className.includes("table");

  if (!hasTableClass && !children) return node;

  return {
    ...node,
    ...(hasTableClass
      ? {
          properties: {
            ...node.properties,
            className: className.filter((name) => name !== "table"),
          },
        }
      : {}),
    ...(children ? { children } : {}),
  };
}
