import type { ReactNode } from "react";
import { MarkdownText } from "@/components/MarkdownText";

const HIDDEN_PROPERTIES = new Set(["banner", "cover", "banner_x", "banner_y"]);

function propertyValue(value: unknown): ReactNode {
  if (Array.isArray(value)) return <span className="flex flex-wrap gap-1">{value.map((item, index) =>
    <span key={index} className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">{String(item)}</span>)}</span>;
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

function positionPercent(value: unknown): number {
  const parsed = value == null ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return parsed > 1 && parsed <= 100 ? parsed : Math.max(0, Math.min(1, parsed)) * 100;
}

/** lover 的日记文档外观，图片继续使用 gateway 签名映射。 */
export function LibraryDocument({ children, path, properties = {}, localImages = {}, onOpenFilePreview }: {
  children: string;
  path: string;
  properties?: Record<string, unknown>;
  localImages?: Record<string, string>;
  onOpenFilePreview: (path: string) => void;
}) {
  const title = path.split("/").pop()?.replace(/\.(?:md|markdown)$/i, "") ?? "";
  const bannerValue = properties.banner || properties.cover;
  let banner = typeof bannerValue === "string" ? bannerValue.trim() : "";
  if (banner.startsWith("[[") && banner.endsWith("]]")) banner = banner.slice(2, -2).split("|", 1)[0].trim();
  let key = banner;
  try { key = decodeURIComponent(key); } catch { /* 保留无法解码的原始路径。 */ }
  const bannerUrl = /^https?:\/\//i.test(banner) ? banner : Object.hasOwn(localImages, key) ? localImages[key] : null;
  const entries = Object.entries(properties).filter(([key, value]) =>
    !HIDDEN_PROPERTIES.has(key) && value != null && value !== "" && (!Array.isArray(value) || value.length > 0));

  return <article className="diary-document mx-auto w-full max-w-[920px] pb-10">
    {bannerUrl ? <div className="relative mb-5 h-48 overflow-hidden rounded-2xl border border-border/50 shadow-sm sm:h-56">
      <img src={bannerUrl} alt="" className="h-full w-full object-cover"
        style={{ objectPosition: `${positionPercent(properties.banner_x)}% ${positionPercent(properties.banner_y)}%` }} />
      {title && <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-5 pb-4 pt-12 text-xl font-semibold text-white">{title}</div>}
    </div> : title ? <h1 className="mb-4 text-2xl font-semibold tracking-tight">{title}</h1> : null}
    {entries.length > 0 && <dl className="mb-6 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-muted/25 px-4 py-3 text-sm">
      {entries.map(([key, value]) => <div key={key} className="contents">
        <dt className="text-muted-foreground">{key}</dt><dd className="min-w-0 break-words text-foreground/90">{propertyValue(value)}</dd>
      </div>)}
    </dl>}
    <MarkdownText document localImages={localImages} onOpenFilePreview={onOpenFilePreview}>{children}</MarkdownText>
  </article>;
}
