import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "@/components/CodeBlock";
import {
  DIARY_IMAGE_URL_PREFIX,
  obsidianImageName,
  rewriteObsidianImages,
} from "@/lib/workspaceViewer";
import { cn } from "@/lib/utils";

interface MarkdownNode {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  data?: Record<string, unknown>;
}

function remarkObsidianCallouts() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "blockquote") {
        const titleNode = node.children?.[0];
        const marker = titleNode?.type === "paragraph" ? titleNode.children?.[0] : null;
        const match = marker?.type === "text"
          ? /^\[!([^\]]+)\]([+-])?\s*(.*)$/.exec(marker.value ?? "")
          : null;
        if (match && marker && titleNode) {
          const type = match[1].trim().toLowerCase();
          marker.value = match[3].trim() || type;
          node.data = {
            hName: "div",
            hProperties: {
              className: ["obsidian-callout"],
              "data-callout": type,
              ...(match[2] ? { "data-callout-fold": match[2] } : {}),
            },
          };
          titleNode.data = {
            hName: "div",
            hProperties: { className: ["callout-title"] },
          };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const baseRemarkPlugins = [remarkBreaks, remarkGfm];
const diaryRemarkPlugins = [...baseRemarkPlugins, remarkObsidianCallouts];
const HIDDEN_PROPERTIES = new Set(["banner", "cover", "banner_x", "banner_y"]);
const TIMELINE_PLACEHOLDER_RE = /<div\s+class=["']timeline-container["'][^>]*><\/div>/gi;
const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon);base64,[a-z0-9+/=]+$/i;

function workspaceMarkdownUrlTransform(url: string): string {
  if (url.startsWith(DIARY_IMAGE_URL_PREFIX)) return url;
  return SAFE_IMAGE_DATA_URL_RE.test(url) ? url : defaultUrlTransform(url);
}

interface WorkspaceMarkdownProps {
  children: string;
  className?: string;
  path?: string;
  diary?: boolean;
  frontmatter?: Record<string, unknown>;
  resolveImage?: (name: string) => Promise<string | null>;
}

function hasPropertyValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function propertyValue(value: unknown): ReactNode {
  if (Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item, index) => (
          <span key={`${String(item)}-${index}`} className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
            {String(item)}
          </span>
        ))}
      </span>
    );
  }
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function positionPercent(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback * 100;
  if (parsed > 1 && parsed <= 100) return parsed;
  return Math.max(0, Math.min(1, parsed)) * 100;
}

function DiaryInlineImage({
  name,
  width,
  height,
  resolveImage,
}: {
  name: string;
  width?: number;
  height?: number;
  resolveImage: (name: string) => Promise<string | null>;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let started = false;
    setSrc(null);
    setFailed(false);
    const load = () => {
      if (started) return;
      started = true;
      void resolveImage(name).then((url) => {
        if (cancelled) return;
        if (url && SAFE_IMAGE_DATA_URL_RE.test(url)) setSrc(url);
        else setFailed(true);
      }).catch(() => { if (!cancelled) setFailed(true); });
    };
    if (typeof IntersectionObserver === "undefined" || !hostRef.current) {
      load();
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: "400px 0px" });
    observer.observe(hostRef.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [name, resolveImage]);

  const style = {
    width: width ? `${width}px` : "100%",
    maxWidth: "100%",
    ...(width && height ? { aspectRatio: `${width} / ${height}` } : {}),
  };
  return (
    <span ref={hostRef} className="my-4 block" style={style}>
      {src ? (
        <img
          src={src}
          alt={name}
          width={width}
          height={height}
          className="mx-auto h-auto max-w-full rounded-xl border border-border/50 shadow-sm"
        />
      ) : (
        <span className="flex min-h-24 items-center justify-center rounded-xl border border-border/50 bg-muted/25 px-3 text-xs text-muted-foreground">
          {failed ? `图片无法加载：${name}` : `正在加载图片：${name}`}
        </span>
      )}
    </span>
  );
}

/** 工作区/日记库共用 Markdown；日记模式额外兼容一小组 Obsidian 展示语法。 */
export function WorkspaceMarkdown({
  children,
  className,
  path,
  diary = false,
  frontmatter,
  resolveImage,
}: WorkspaceMarkdownProps) {
  const [localBannerUrl, setLocalBannerUrl] = useState<string | null>(null);
  const bannerValue = frontmatter?.banner ?? frontmatter?.cover;
  const localBanner = obsidianImageName(bannerValue);

  useEffect(() => {
    let cancelled = false;
    setLocalBannerUrl(null);
    if (!resolveImage || !localBanner) return () => { cancelled = true; };
    void resolveImage(localBanner).then((url) => {
      if (!cancelled && url && SAFE_IMAGE_DATA_URL_RE.test(url)) setLocalBannerUrl(url);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [localBanner, resolveImage]);

  const markdown = useMemo(
    () => diary
      ? rewriteObsidianImages(children.replace(TIMELINE_PLACEHOLDER_RE, ""))
      : children,
    [children, diary],
  );
  const title = path?.split("/").pop()?.replace(/\.(?:md|markdown)$/i, "") ?? "";
  const bannerUrl = localBanner
    ? localBannerUrl
    : typeof bannerValue === "string" && /^(?:https?:|data:image\/)/i.test(bannerValue)
      ? bannerValue
      : null;
  const properties = Object.entries(frontmatter ?? {}).filter(
    ([key, value]) => !HIDDEN_PROPERTIES.has(key) && hasPropertyValue(value),
  );

  const components = useMemo<Components>(
    () => ({
      code({ className: cls, children: kids, ...props }) {
        const match = /language-(\w+)/.exec(cls || "");
        if (match) {
          const code = String(kids).replace(/\n$/, "");
          return <CodeBlock language={match[1]} code={code} className="my-3" wrapLongLines />;
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
      img({ title: imageTitle, alt, ...props }) {
        const src = typeof props.src === "string" ? props.src : "";
        if (src.startsWith(DIARY_IMAGE_URL_PREFIX) && resolveImage) {
          let name = src.slice(DIARY_IMAGE_URL_PREFIX.length);
          try { name = decodeURIComponent(name); } catch { /* keep encoded fallback */ }
          const size = /^size=(\d+)(?:x(\d+))?$/.exec(imageTitle ?? "");
          return (
            <DiaryInlineImage
              name={name}
              width={size?.[1] ? Number(size[1]) : undefined}
              height={size?.[2] ? Number(size[2]) : undefined}
              resolveImage={resolveImage}
            />
          );
        }
        return (
          <img
            {...props}
            alt={alt ?? ""}
            className="mx-auto rounded-xl border border-border/50 shadow-sm"
            style={{ maxWidth: "100%" }}
            loading="lazy"
          />
        );
      },
    }),
    [resolveImage],
  );

  return (
    <article className={cn(diary && "diary-document mx-auto w-full max-w-[920px] pb-10", className)}>
      {diary && bannerUrl ? (
        <div className="relative mb-5 h-48 overflow-hidden rounded-2xl border border-border/50 shadow-sm sm:h-56">
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            style={{
              objectPosition: `${positionPercent(frontmatter?.banner_x, 0.5)}% ${positionPercent(frontmatter?.banner_y, 0.5)}%`,
            }}
          />
          {title ? (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-5 pb-4 pt-12 text-xl font-semibold text-white">
              {title}
            </div>
          ) : null}
        </div>
      ) : diary && title ? (
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">{title}</h1>
      ) : null}

      {diary && properties.length > 0 ? (
        <dl className="mb-6 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-muted/25 px-4 py-3 text-sm">
          {properties.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-words text-foreground/90">{propertyValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div
        className={cn(
          "markdown-content prose max-w-none dark:prose-invert",
          "prose-headings:font-semibold prose-p:my-2",
          diary && "prose-headings:border-b prose-headings:border-border/50 prose-headings:pb-1 prose-img:my-4",
        )}
      >
        <ReactMarkdown
          remarkPlugins={diary ? diaryRemarkPlugins : baseRemarkPlugins}
          components={components}
          urlTransform={workspaceMarkdownUrlTransform}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </article>
  );
}
