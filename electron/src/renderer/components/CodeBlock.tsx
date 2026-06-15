import { Suspense, lazy, useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

import { isDarkTheme, useThemeValue } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  language?: string;
  code: string;
  className?: string;
  highlight?: boolean;
  wrapLongLines?: boolean;
}

interface HighlightedCodeProps {
  language?: string;
  code: string;
  isDark: boolean;
  wrapLongLines: boolean;
}

const LazyHighlightedCode = lazy(async () => {
  const [
    { default: SyntaxHighlighter },
    { default: oneDark },
    { default: oneLight },
  ] = await Promise.all([
    import("react-syntax-highlighter/dist/esm/prism-async-light"),
    import("react-syntax-highlighter/dist/esm/styles/prism/one-dark"),
    import("react-syntax-highlighter/dist/esm/styles/prism/one-light"),
  ]);

  return {
    default({ language, code, isDark, wrapLongLines }: HighlightedCodeProps) {
      const wrapStyle = wrapLongLines
        ? ({
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          } as const)
        : null;

      return (
        <SyntaxHighlighter
          language={language}
          style={isDark ? oneDark : oneLight}
          customStyle={{
            margin: 0,
            padding: "1rem",
            fontSize: "0.875rem",
            lineHeight: 1.6,
            background: "transparent",
            width: "100%",
            maxWidth: "100%",
            minWidth: 0,
            ...(wrapStyle ?? {}),
          }}
          codeTagProps={
            wrapLongLines
              ? {
                  className: language ? `language-${language}` : undefined,
                  // 库内 merge 顺序会让 Prism 主题的 whiteSpace: pre 盖掉 pre-wrap，需显式传入
                  style: { ...wrapStyle },
                }
              : undefined
          }
          PreTag="pre"
          wrapLongLines={wrapLongLines}
        >
          {code}
        </SyntaxHighlighter>
      );
    },
  };
});

function PlainCodeFallback({ code, wrapLongLines = false }: { code: string; wrapLongLines?: boolean }) {
  return (
    <pre
      className={cn(
        "m-0 p-4 font-mono text-sm leading-[1.6]",
        wrapLongLines ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
      )}
    >
      <code>{code}</code>
    </pre>
  );
}

export function CodeBlock({
  language,
  code,
  className,
  highlight = true,
  wrapLongLines = false,
}: CodeBlockProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isDark = isDarkTheme(useThemeValue());

  const onCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  }, [code]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border",
        wrapLongLines && "w-full min-w-0 max-w-full",
        isDark ? "border-white/10" : "border-black/10",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between px-4 py-1.5 text-xs font-medium",
          isDark
            ? "bg-muted text-muted-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        <span className="lowercase font-mono">
          {language || t("code.fallbackLanguage")}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono transition-colors",
            isDark
              ? "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              : "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700",
          )}
          aria-label={t("code.copyAria")}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          <span>{copied ? t("code.copied") : t("code.copy")}</span>
        </button>
      </div>
      <div className={cn("bg-muted", wrapLongLines && "w-full min-w-0 max-w-full")}>
        {highlight ? (
          <Suspense fallback={<PlainCodeFallback code={code} wrapLongLines={wrapLongLines} />}>
            <LazyHighlightedCode
              language={language}
              code={code}
              isDark={isDark}
              wrapLongLines={wrapLongLines}
            />
          </Suspense>
        ) : (
          <PlainCodeFallback code={code} wrapLongLines={wrapLongLines} />
        )}
      </div>
    </div>
  );
}
