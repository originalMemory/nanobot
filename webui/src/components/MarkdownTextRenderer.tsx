import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, Globe2 } from "lucide-react";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Streamdown, type Components, type StreamdownProps } from "streamdown";

import { AttachmentTile } from "@/components/AttachmentTile";
import { CodeBlock } from "@/components/CodeBlock";
import { useCodeWrap } from "@/hooks/useCodeWrap";
import {
  INLINE_TOKEN_HIGHLIGHT_COLOR,
  InlineTokenHighlight,
} from "@/components/InlineTokenHighlight";
import {
  useFilePreviewAvailabilityResolver,
  type FilePreviewAvailabilityResolver,
} from "@/components/FilePreviewAvailabilityContext";
import {
  FileReferenceChip,
  isFilePatternReference,
  isLikelyFilePath,
} from "@/components/FileReferenceChip";
import { useLogoFallback } from "@/hooks/useLogoFallback";
import { inferMediaKind } from "@/lib/media";
import { browserSafeFaviconUrls } from "@/lib/provider-brand";
import { remarkTexMath } from "@/lib/remark-tex-math";
import { cn } from "@/lib/utils";

import "streamdown/styles.css";

interface MarkdownTextRendererProps {
  children: string;
  className?: string;
  highlightCode?: boolean;
  streaming?: boolean;
  onOpenFilePreview?: (path: string) => void;
  localImages?: Record<string, string>;
  document?: boolean;
}

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  title?: string;
  children?: MarkdownAstNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
};

type InlineLinkPreview = {
  href: string;
  host: string;
  prefix?: string;
  title: string;
};

type AvailabilityResult = {
  available: boolean;
  path: string;
  resolve: FilePreviewAvailabilityResolver;
};

function InferredFileReferenceChip({
  path,
  onOpen,
}: {
  path: string;
  onOpen?: (path: string) => void;
}) {
  const resolve = useFilePreviewAvailabilityResolver();
  const [result, setResult] = useState<AvailabilityResult | null>(null);

  useEffect(() => {
    if (!resolve || !onOpen) return;
    let cancelled = false;
    resolve(path)
      .then((available) => {
        if (!cancelled) setResult({ available, path, resolve });
      })
      .catch(() => {
        if (!cancelled) setResult({ available: false, path, resolve });
      });
    return () => {
      cancelled = true;
    };
  }, [onOpen, path, resolve]);

  const resolvedAvailable = !resolve || (
    result?.resolve === resolve
    && result.path === path
    && result.available
  );
  return (
    <FileReferenceChip
      path={path}
      onOpen={onOpen && resolvedAvailable ? onOpen : undefined}
    />
  );
}

const SAFE_INLINE_HTML_TAGS = new Set(["mark", "sub", "sup"]);
const DIARY_TIMELINE_MONTHS = [
  ["1月", 31, "#cfe2f3"],
  ["2月", 28, "#a2b1c9"],
  ["3月", 31, "#76a5af"],
  ["4月", 30, "#93c47d"],
  ["5月", 31, "#6aa84f"],
  ["6月", 30, "#8fce00"],
  ["7月", 31, "#ffd966"],
  ["8月", 31, "#f1c232"],
  ["9月", 30, "#ce7e00"],
  ["10月", 31, "#e06666"],
  ["11月", 30, "#f4cccc"],
  ["12月", 31, "#eeeeee"],
] as const;

function DiaryTimeline({ day }: { day: number }) {
  const totalDays = day === 366 ? 366 : 365;
  const progress = Math.min(100, Math.max(0, ((day - 0.5) / totalDays) * 100));
  const columns = DIARY_TIMELINE_MONTHS.map(([, days]) => `${days}fr`).join(" ");
  return (
    <div
      role="img"
      aria-label={`Day ${day} of ${totalDays}`}
      data-testid="diary-timeline"
      className="not-prose my-5 w-full"
    >
      <div className="relative">
        <div
          className="grid h-1.5 gap-px overflow-hidden rounded-full"
          style={{ gridTemplateColumns: columns }}
          aria-hidden
        >
          {DIARY_TIMELINE_MONTHS.map(([month, , color]) => (
            <span key={month} style={{ backgroundColor: color }} />
          ))}
        </div>
        <span
          className="absolute top-[-3px] h-3 w-0.5 -translate-x-1/2 rounded-full bg-red-500 shadow-sm"
          style={{ left: `${progress}%` }}
          aria-hidden
        />
      </div>
      <div
        className="mt-1.5 grid gap-px text-[8px] leading-none text-muted-foreground sm:text-[9px]"
        style={{ gridTemplateColumns: columns }}
        aria-hidden
      >
        {DIARY_TIMELINE_MONTHS.map(([month]) => (
          <span key={month} className="truncate">{month}</span>
        ))}
      </div>
    </div>
  );
}

function extensionOf(value: string): string {
  const clean = value.split(/[?#]/, 1)[0]?.trim() ?? "";
  const slash = clean.lastIndexOf("/");
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function markdownAttachmentKind(source: string, label: string): "image" | "video" | "file" {
  const inferredKind = inferMediaKind({ url: source, name: label });
  if (inferredKind !== "file") return inferredKind;
  return extensionOf(label) || extensionOf(source) ? "file" : "image";
}

function safeHtmlNode(tagName: string, children: MarkdownAstNode[]): MarkdownAstNode {
  return {
    type: `nanobotSafeHtml${tagName}`,
    data: { hName: tagName },
    children,
  };
}

function safeText(value: string): MarkdownAstNode {
  return { type: "text", value };
}

function htmlTag(node: MarkdownAstNode): { tag: string; closing: boolean } | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;
  const match = /^<\s*(\/?)\s*(mark|sub|sup)\s*>$/i.exec(node.value.trim());
  if (!match) return null;
  return { tag: match[2].toLowerCase(), closing: match[1] === "/" };
}

function normalizeSafeInlineHtml(children: MarkdownAstNode[]): MarkdownAstNode[] {
  const next: MarkdownAstNode[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (node.children) {
      node.children = normalizeSafeInlineHtml(node.children);
    }

    const tag = htmlTag(node);
    if (!tag || tag.closing || !SAFE_INLINE_HTML_TAGS.has(tag.tag)) {
      next.push(node);
      continue;
    }

    let closeIndex = -1;
    for (let cursor = index + 1; cursor < children.length; cursor += 1) {
      const closeTag = htmlTag(children[cursor]);
      if (closeTag?.closing && closeTag.tag === tag.tag) {
        closeIndex = cursor;
        break;
      }
    }

    if (closeIndex === -1) {
      next.push(node);
      continue;
    }

    next.push(
      safeHtmlNode(
        tag.tag,
        normalizeSafeInlineHtml(children.slice(index + 1, closeIndex)),
      ),
    );
    index = closeIndex;
  }
  return next;
}

function detailsOpen(node: MarkdownAstNode): { summary: string } | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;
  const value = node.value.trim();
  const match = /^<\s*details\s*>\s*<\s*summary\s*>([\s\S]*?)<\s*\/\s*summary\s*>$/i.exec(value);
  if (match) return { summary: match[1].trim() };
  if (/^<\s*details\s*>$/i.test(value)) return { summary: "Details" };
  return null;
}

function isDetailsClose(node: MarkdownAstNode): boolean {
  return node.type === "html"
    && typeof node.value === "string"
    && /^<\s*\/\s*details\s*>$/i.test(node.value.trim());
}

function normalizeSafeDetails(children: MarkdownAstNode[]): MarkdownAstNode[] {
  const next: MarkdownAstNode[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const open = detailsOpen(node);
    if (!open) {
      next.push(node);
      continue;
    }

    const closeIndex = children.findIndex(
      (candidate, candidateIndex) => candidateIndex > index && isDetailsClose(candidate),
    );
    if (closeIndex === -1) {
      next.push(node);
      continue;
    }

    const body = normalizeSafeInlineHtml(
      normalizeSafeDetails(children.slice(index + 1, closeIndex)),
    );
    next.push({
      type: "nanobotSafeHtmlDetails",
      data: { hName: "details" },
      children: [
        {
          type: "nanobotSafeHtmlSummary",
          data: { hName: "summary" },
          children: [safeText(open.summary)],
        },
        ...body,
      ],
    });
    index = closeIndex;
  }
  return next;
}

function remarkSafeHtmlSubset() {
  return (tree: MarkdownAstNode) => {
    if (tree.children) {
      tree.children = normalizeSafeInlineHtml(normalizeSafeDetails(tree.children));
    }
  };
}

// Recover a common model-output edge case that CommonMark leaves as literal
// text: `**结论。**如果`, with no separator after the closing delimiter.
const CJK_AFTER_STRONG =
  /(?<!\\)\*\*([^*\r\n]+?)(?<!\\)\*\*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;

function normalizeCjkStrongBoundaries(node: MarkdownAstNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value?.includes("**")) {
      normalizeCjkStrongBoundaries(child);
      return [child];
    }

    const replacement: MarkdownAstNode[] = [];
    let cursor = 0;
    for (const match of child.value.matchAll(CJK_AFTER_STRONG)) {
      const start = match.index;
      if (start > cursor) replacement.push(safeText(child.value.slice(cursor, start)));
      replacement.push({
        type: "strong",
        children: [safeText(match[1])],
      });
      cursor = start + match[0].length;
    }
    if (cursor === 0) return [child];
    if (cursor < child.value.length) replacement.push(safeText(child.value.slice(cursor)));
    return replacement;
  });
}

function remarkCjkStrongBoundaries() {
  return (tree: MarkdownAstNode) => {
    normalizeCjkStrongBoundaries(tree);
  };
}

function remarkWikiImages() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const parts: MarkdownAstNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/!\[\[([^\]]+)\]\]/g)) {
          if (match.index > offset) parts.push({ type: "text", value: child.value.slice(offset, match.index) });
          const name = match[1].split("|", 1)[0].trim();
          const size = /\|(\d+)(?:x(\d+))?$/.exec(match[1]);
          parts.push({ type: "image", url: name, alt: name, ...(size ? { title: `size=${size[1]}${size[2] ? `x${size[2]}` : ""}` } : {}) });
          offset = match.index + match[0].length;
        }
        if (!offset) return [child];
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}

const remarkPlugins: NonNullable<StreamdownProps["remarkPlugins"]> = [
  remarkBreaks,
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkTexMath,
  remarkCjkStrongBoundaries,
  remarkSafeHtmlSubset,
];
const libraryRemarkPlugins: NonNullable<StreamdownProps["remarkPlugins"]> = [...remarkPlugins, remarkWikiImages];

/** 只在文档预览中恢复 lover 的 Obsidian callout，不改聊天渲染。 */
function remarkDiaryDocument() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "blockquote") {
        const title = node.children?.[0];
        const marker = title?.type === "paragraph" ? title.children?.[0] : null;
        const match = marker?.type === "text" ? /^\[!([^\]]+)\]([+-])?[ \t]*(.*)/.exec(marker.value ?? "") : null;
        if (match && marker && title) {
          const type = match[1].trim().toLowerCase();
          // remarkBreaks 已将换行转成 break，只把首行作为标题，其余留在正文。
          const lineBreak = title.children?.findIndex((child) => child.type === "break") ?? -1;
          if (lineBreak >= 0 && title.children) {
            const body = title.children.splice(lineBreak);
            body.shift();
            if (body.length) node.children?.splice(1, 0, { type: "paragraph", children: body });
          }
          marker.value = match[3].trim() || (title.children?.length === 1 ? type : "");
          node.data = { hName: "div", hProperties: { className: ["obsidian-callout"], "data-callout": type } };
          title.data = { hName: "div", hProperties: { className: ["callout-title"] } };
        }
      }
      node.children = node.children?.flatMap((child) => {
        if (child.type !== "html" || typeof child.value !== "string") return [child];
        const html = child.value.trim();
        if (!/^<div\b[^>]*><\/div>$/i.test(html)) return [child];
        const classes = /\bclass=["']([^"']*)["']/i.exec(html)?.[1]?.split(/\s+/) ?? [];
        if (!classes.includes("timeline-container")) return [child];
        const rawDay = /\bdata-dv-key=["']timeline(\d{1,3})["']/i.exec(html)?.[1];
        const day = rawDay ? Number(rawDay) : NaN;
        if (!Number.isInteger(day) || day < 1 || day > 366) return [];
        return [{
          type: "nanobotDiaryTimeline",
          data: {
            hName: "div",
            hProperties: { "data-diary-timeline-day": day },
          },
          children: [],
        }];
      });
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
const documentRemarkPlugins: NonNullable<StreamdownProps["remarkPlugins"]> = [...libraryRemarkPlugins, remarkDiaryDocument];
type MathPlugin = typeof import("@/lib/markdown-math").default;
let loadedMathPlugin: MathPlugin | undefined;
let mathPluginPromise: Promise<MathPlugin> | undefined;

function loadMathPlugin(): Promise<MathPlugin> {
  return mathPluginPromise ??= import("@/lib/markdown-math").then((module) => {
    loadedMathPlugin = module.default;
    return module.default;
  }).catch((error) => {
    mathPluginPromise = undefined;
    throw error;
  });
}

// Remend mistakes math comparisons like `j<i` for incomplete HTML and truncates
// the remaining text. HTML is handled by remarkSafeHtmlSubset, not raw rendering.
const REMEND_OPTIONS = { htmlTags: false } as const;
const DIRECT_LINKS = { enabled: false } as const;
const SAFE_MARKDOWN_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/** Preserve react-markdown's URL policy when rendering through Streamdown. */
const safeMarkdownUrl: NonNullable<StreamdownProps["urlTransform"]> = (url) => {
  const colon = url.indexOf(":");
  const questionMark = url.indexOf("?");
  const hash = url.indexOf("#");
  const slash = url.indexOf("/");
  const relative = colon === -1
    || (slash !== -1 && colon > slash)
    || (questionMark !== -1 && colon > questionMark)
    || (hash !== -1 && colon > hash);
  return relative || SAFE_MARKDOWN_PROTOCOL.test(url.slice(0, colon)) ? url : "";
};

function nodeText(value: ReactNode): string {
  return Children.toArray(value)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (!isValidElement<{ children?: ReactNode }>(child)) return "";
      return nodeText(child.props.children);
    })
    .join("");
}

function cleanFileReferenceTarget(value: string): string {
  let target = value.trim();
  if (!target) return "";
  try {
    if (/^file:\/\//i.test(target)) {
      target = decodeURIComponent(new URL(target).pathname);
    } else {
      target = decodeURIComponent(target);
    }
  } catch {
    // Keep the raw value when URL/path decoding is not possible.
  }
  target = target.split("?", 1)[0]?.split("#", 1)[0]?.trim() ?? "";
  if (!/^[A-Za-z]:[\\/]/.test(target)) {
    target = target.replace(/:\d+(?::\d+)?$/, "");
  }
  return target;
}

function isPreviewableFileTarget(value: string): boolean {
  if (isFilePatternReference(value)) return false;
  if (isLikelyFilePath(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (/[\\/]/.test(value)) return false;
  return /^[^?#]+\.[a-z0-9][a-z0-9_-]{0,12}$/i.test(value);
}

function isNonNavigableFilePatternLink(href: string | undefined): boolean {
  if (!href || /^https?:\/\//i.test(href) || href.startsWith("#")) return false;
  const target = cleanFileReferenceTarget(href);
  return Boolean(target && isFilePatternReference(target));
}

function fileReferenceFromLink(href: string | undefined): string | null {
  if (!href || /^https?:\/\//i.test(href) || href.startsWith("#")) return null;
  const target = cleanFileReferenceTarget(href);
  return isPreviewableFileTarget(target) ? target : null;
}

function sessionReferenceHref(href: string): string | null {
  const prefix = href.startsWith("#session/")
    ? "#session/"
    : href.startsWith("#/chat/")
      ? "#/chat/"
      : null;
  if (!prefix) return null;
  try {
    const sessionKey = decodeURIComponent(href.slice(prefix.length)).trim();
    if (!sessionKey.startsWith("websocket:") || sessionKey === "websocket:") return null;
    return `#/chat/${encodeURIComponent(sessionKey)}`;
  } catch {
    return null;
  }
}

function linkPreviewParts(value: ReactNode): { text: string; href?: string } {
  let text = "";
  let href: string | undefined;
  for (const child of Children.toArray(value)) {
    if (typeof child === "string" || typeof child === "number") {
      text += String(child);
      continue;
    }
    if (!isValidElement(child)) {
      continue;
    }
    const props = child.props as { href?: unknown; children?: ReactNode };
    if (!href && typeof props.href === "string" && /^https?:\/\//i.test(props.href)) {
      href = props.href;
    }
    const nested = linkPreviewParts(props.children);
    text += nested.text;
    href ||= nested.href;
  }
  return { text, href };
}

function cleanLinkPreviewText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .trim();
}

function inlineLinkPreviewFromChildren(children: ReactNode): InlineLinkPreview | null {
  const { text: rawText, href } = linkPreviewParts(children);
  if (!href) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const strippedUrl = rawText
    .replace(/\s+/g, " ")
    .replace(href, "")
    .replace(url.toString(), "")
    .replace(/https?:\/\/\S+/i, "")
    .trim();
  if (!strippedUrl || strippedUrl.length < 4) return null;

  const sourceMatch = /^(.*?)\s*(?:[—–]| - |:)\s*(.+)$/.exec(strippedUrl);
  const prefix = sourceMatch?.[1] ? cleanLinkPreviewText(sourceMatch[1]) : undefined;
  const title = cleanLinkPreviewText(sourceMatch?.[2] ?? strippedUrl);
  if (!title || /^https?:\/\//i.test(title)) return null;

  return {
    href,
    host: url.hostname,
    prefix,
    title,
  };
}

function InlineLinkPreviewRow({ link }: { link: InlineLinkPreview }) {
  const { t } = useTranslation();
  const { favicon, onFaviconError, onFaviconLoad } = useFaviconFallback(link.host);
  const label = link.prefix
    ? `${link.prefix} — ${link.title}`
    : link.title;

  return (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={t("message.openLink", { label })}
      className={cn(
        "not-prose inline-flex max-w-full items-center gap-2 align-baseline",
        "text-blue-500 no-underline underline-offset-2 hover:underline dark:text-blue-300",
      )}
    >
      <span
        className={cn(
          "relative grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded-mark",
          "border border-border/65 bg-background text-muted-foreground",
        )}
        aria-hidden
      >
        {favicon ? (
          <img
            src={favicon}
            alt=""
            className="h-3 w-3 rounded-mark object-contain"
            decoding="async"
            loading="lazy"
            referrerPolicy="no-referrer"
            draggable={false}
            onLoad={onFaviconLoad}
            onError={onFaviconError}
          />
        ) : (
          <Globe2 className="h-3 w-3" />
        )}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere] leading-normal sm:truncate">
        {label}
      </span>
    </a>
  );
}

function useFaviconFallback(host: string) {
  const faviconCandidates = useMemo(() => browserSafeFaviconUrls(host), [host]);
  const { logoUrl, onLogoError, onLogoLoad } = useLogoFallback(faviconCandidates);

  return {
    favicon: logoUrl ?? null,
    onFaviconError: onLogoError,
    onFaviconLoad: onLogoLoad,
  };
}

function isRenderedCodeBlock(value: ReactNode): boolean {
  if (!isValidElement(value)) return false;
  const props = value.props as { code?: unknown };
  return value.type === CodeBlock || typeof props.code === "string";
}

function codeFenceFromPreChild(value: ReactNode): { code: string; language?: string } | null {
  if (!isValidElement(value)) return null;
  const props = value.props as { className?: unknown; children?: ReactNode };
  if (!("children" in props)) return null;
  const className = typeof props.className === "string" ? props.className : "";
  const language = /language-([^\s]+)/.exec(className)?.[1];
  return {
    code: nodeText(props.children).replace(/\n$/, ""),
    language,
  };
}

/**
 * Heavy markdown stack (GFM, math, KaTeX, syntax highlighting) kept in a
 * separate chunk so the app shell can paint sooner on refresh.
 */
export default function MarkdownTextRenderer({
  children,
  className,
  highlightCode = true,
  streaming = false,
  onOpenFilePreview,
  localImages,
  document = false,
}: MarkdownTextRendererProps) {
  const { t } = useTranslation();
  const codeWrap = useCodeWrap();
  const [mathPlugin, setMathPlugin] = useState(() => loadedMathPlugin);
  const needsMath = /\$|\\[([]/.test(children);
  useEffect(() => {
    if (!needsMath || mathPlugin) return;
    let cancelled = false;
    void loadMathPlugin().then((plugin) => {
      if (!cancelled) setMathPlugin(() => plugin);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsMath, mathPlugin]);
  const rehypePlugins = useMemo<NonNullable<StreamdownProps["rehypePlugins"]>>(
    () => needsMath && mathPlugin ? [mathPlugin] : [],
    [needsMath, mathPlugin],
  );
  const components = useMemo<Components>(
    () => ({
      div({ children: markdownChildren, node: _node, ...props }) {
        void _node;
        const rawDay = (props as Record<string, unknown>)["data-diary-timeline-day"];
        const day = typeof rawDay === "number" ? rawDay : Number(rawDay);
        if (document && Number.isInteger(day) && day >= 1 && day <= 366) {
          return <DiaryTimeline day={day} />;
        }
        return <div {...props}>{markdownChildren}</div>;
      },
      code({ className: cls, children: kids, node: _node, ...props }) {
        void _node;
        const match = /language-(\w+)/.exec(cls || "");
        if (match) {
          const code = String(kids).replace(/\n$/, "");
          return (
            <CodeBlock
              language={match[1]}
              code={code}
              className="my-3"
              highlight={highlightCode}
              showLineNumbers={code.includes("\n")}
              wrapLongLines={codeWrap}
            />
          );
        }
        const raw = String(kids).replace(/\n$/, "");
        if (!document && isLikelyFilePath(raw)) {
          return (
            <InferredFileReferenceChip
              path={raw}
              onOpen={onOpenFilePreview}
            />
          );
        }
        /** Plain fenced ``` blocks (no language) & wide one-liners: block monospace, not inline pill. */
        const widePlainBlock = raw.includes("\n") || raw.length > 120;
        if (widePlainBlock) {
          return (
            <code
              className={cn(
                "block min-w-0 max-w-full overflow-x-auto bg-transparent p-0 font-mono text-[0.8125rem]",
                "leading-snug text-inherit",
                codeWrap
                  ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                  : "whitespace-pre [overflow-wrap:normal]",
                cls,
              )}
              {...props}
            >
              {kids}
            </code>
          );
        }
        return (
          <code
            className={cn(
              "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
              cls,
            )}
            {...props}
          >
            {kids}
          </code>
        );
      },
      pre({ children: markdownChildren }) {
        const kids = Children.toArray(markdownChildren);
        const lone = kids.length === 1 ? kids[0] : null;
        /** Highlighted fences render ``CodeBlock`` (block shell); skip invalid ``<pre><div>``. */
        if (isRenderedCodeBlock(lone)) {
          return <>{markdownChildren}</>;
        }
        const fence = codeFenceFromPreChild(lone);
        if (fence) {
          return (
            <CodeBlock
              language={fence.language || "text"}
              code={fence.code}
              className="my-3"
              highlight={highlightCode}
              showLineNumbers={fence.code.includes("\n")}
              wrapLongLines={codeWrap}
            />
          );
        }
        return (
          <pre
            className={cn(
              "my-3 overflow-x-auto rounded-lg border border-border/60 bg-muted/35",
              "p-3 font-mono text-[0.8125rem] leading-snug text-foreground/90",
              codeWrap
                ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                : "whitespace-pre [overflow-wrap:normal]",
            )}
          >
            {markdownChildren}
          </pre>
        );
      },
      a({ href, children: markdownChildren, node: _node, ...props }) {
        void _node;
        if (!href) {
          return <>{markdownChildren}</>;
        }
        if (href === "streamdown:incomplete-link") {
          return <>{markdownChildren}</>;
        }
        const sessionHref = sessionReferenceHref(href);
        if (sessionHref) {
          return (
            <a
              href={sessionHref}
              className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              style={{ textDecorationColor: INLINE_TOKEN_HIGHLIGHT_COLOR }}
            >
              <InlineTokenHighlight color={INLINE_TOKEN_HIGHLIGHT_COLOR}>
                {markdownChildren}
              </InlineTokenHighlight>
            </a>
          );
        }
        if (href.startsWith("#/chat/") || href.startsWith("#session/")) {
          return <>{markdownChildren}</>;
        }
        const filePath = fileReferenceFromLink(href);
        if (filePath) {
          const label = nodeText(markdownChildren).trim();
          return (
            <FileReferenceChip
              path={label || filePath}
              tooltipPath={filePath}
              previewPath={filePath}
              onOpen={onOpenFilePreview}
            />
          );
        }
        if (isNonNavigableFilePatternLink(href)) {
          return <>{markdownChildren}</>;
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
            {...props}
          >
            {markdownChildren}
          </a>
        );
      },
      // Streamdown decorates emphasis with spans by default. Preserve native
      // semantics for accessibility and predictable typography.
      strong({ children: markdownChildren, node: _node, ...props }) {
        void _node;
        return <strong {...props}>{markdownChildren}</strong>;
      },
      em({ children: markdownChildren, node: _node, ...props }) {
        void _node;
        return <em {...props}>{markdownChildren}</em>;
      },
      del({ children: markdownChildren, node: _node, ...props }) {
        void _node;
        return <del {...props}>{markdownChildren}</del>;
      },
      table({ children: tableChildren, node: _node, ...props }) {
        void _node;
        return (
          <div
            data-testid="markdown-data-table"
            data-table-kind="data"
            role="region"
            tabIndex={0}
            aria-label={t("message.dataTable", { defaultValue: "Data table" })}
            className={cn(
              "not-prose mb-5 mt-3 w-full max-w-full overflow-x-auto rounded-lg",
              "border border-border/65 bg-muted/20",
              "overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <table
              className={cn(
                "w-full min-w-max border-collapse text-[13px] leading-5",
                "[&_thead]:bg-muted/45 [&_thead]:text-muted-foreground",
                "[&_th]:border-b [&_th]:border-border/65 [&_th]:px-3 [&_th]:py-2",
                "[&_th]:text-left [&_th]:font-medium",
                "[&_td]:border-b [&_td]:border-border/55 [&_td]:px-3 [&_td]:py-2",
                "[&_th:not(:last-child)]:border-r [&_th:not(:last-child)]:border-border/45",
                "[&_td:not(:last-child)]:border-r [&_td:not(:last-child)]:border-border/45",
                "[&_tbody_tr:last-child_td]:border-b-0",
              )}
              {...props}
            >
              {tableChildren}
            </table>
          </div>
        );
      },
      li({ children: markdownChildren, className: itemClassName }) {
        const link = inlineLinkPreviewFromChildren(markdownChildren);
        if (link) {
          return (
            <li className={cn("list-none pl-0", itemClassName)}>
              <InlineLinkPreviewRow link={link} />
            </li>
          );
        }
        const taskItem = itemClassName?.includes("task-list-item");
        return (
          <li
            className={cn(
              itemClassName,
              taskItem
                ? "flex min-w-0 items-start gap-2 text-[13px] leading-5 [&>p]:m-0"
                : "[&>p]:inline",
            )}
          >
            {markdownChildren}
          </li>
        );
      },
      input({ type, checked }) {
        if (type !== "checkbox") return null;
        return (
          <span
            aria-hidden
            data-testid="markdown-task-checkbox"
            data-task-checked={checked ? "true" : "false"}
            className={cn(
              "mt-0.5 inline-grid h-4 w-4 shrink-0 place-items-center rounded-full",
              "border border-dashed border-muted-foreground/55 bg-background text-background",
              checked && "border-solid border-emerald-500 bg-emerald-500 text-white",
            )}
          >
            {checked ? <Check className="h-3 w-3 stroke-[3]" /> : null}
          </span>
        );
      },
      mark({ children: markdownChildren }) {
        return (
          <mark className="rounded-compact bg-yellow-200/75 px-1 py-0.5 text-inherit dark:bg-yellow-300/25">
            {markdownChildren}
          </mark>
        );
      },
      sub({ children: markdownChildren }) {
        return <sub className="text-[0.72em] leading-none">{markdownChildren}</sub>;
      },
      sup({ children: markdownChildren }) {
        return <sup className="text-[0.72em] leading-none">{markdownChildren}</sup>;
      },
      details({ children: markdownChildren }) {
        return (
          <details className="my-3 rounded-xl border border-border/65 bg-muted/25 px-4 py-3 open:pb-4">
            {markdownChildren}
          </details>
        );
      },
      summary({ children: markdownChildren }) {
        return (
          <summary className="cursor-pointer select-none text-sm font-medium text-foreground/88 marker:text-muted-foreground">
            {markdownChildren}
          </summary>
        );
      },
      img({ src, alt, node: _node, className: imgClassName, ...props }) {
        void _node;
        void imgClassName;
        void props;
        let source = typeof src === "string" ? src : "";
        if (localImages && !/^https?:\/\//i.test(source) && !source.startsWith("/api/media/")) {
          let key = source;
          try { key = decodeURIComponent(source); } catch { /* Keep malformed literals unmapped. */ }
          if (!Object.hasOwn(localImages, key)) return <span>{alt}</span>;
          source = localImages[key];
        }
        if (!source) return null;
        if (document) {
          const size = /^size=(\d+)(?:x(\d+))?$/.exec(props.title ?? "");
          return <img src={source} alt={alt ?? ""} loading="lazy"
            title={size ? undefined : props.title}
            width={size ? Number(size[1]) : undefined} height={size?.[2] ? Number(size[2]) : undefined}
            className="mx-auto h-auto max-w-full rounded-xl border border-border/50 shadow-sm" />;
        }
        const label = typeof alt === "string" ? alt : "";
        const kind = markdownAttachmentKind(source, label);
        return (
          <AttachmentTile
            attachment={{
              kind,
              url: source,
              name: label,
            }}
            inline
          />
        );
      },
    }),
    [codeWrap, highlightCode, onOpenFilePreview, localImages, document, t],
  );

  return (
    <Streamdown
      key={needsMath && mathPlugin ? "math" : "text"}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown
      remend={REMEND_OPTIONS}
      isAnimating={false}
      animated={false}
      linkSafety={DIRECT_LINKS}
      urlTransform={safeMarkdownUrl}
      remarkPlugins={document ? documentRemarkPlugins : localImages ? libraryRemarkPlugins : remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
      className={cn(
        "markdown-content prose max-w-none dark:prose-invert",
        "prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-headings:tracking-tight",
        document ? "prose-headings:border-b prose-headings:border-border/50 prose-headings:pb-1 prose-img:my-4" : "prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-h4:text-[13px]",
        "prose-p:my-2",
        "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
        "prose-blockquote:my-3 prose-blockquote:border-l-2 prose-blockquote:font-normal",
        "prose-blockquote:not-italic prose-blockquote:text-foreground/80",
        "prose-a:text-blue-500 prose-a:underline-offset-2 hover:prose-a:text-blue-600 dark:prose-a:text-blue-300 dark:hover:prose-a:text-blue-200",
        "prose-hr:my-6",
        "prose-pre:my-0 prose-pre:bg-transparent prose-pre:p-0",
        "prose-code:before:content-none prose-code:after:content-none prose-code:font-normal",
        className,
      )}
    >
      {children}
    </Streamdown>
  );
}
