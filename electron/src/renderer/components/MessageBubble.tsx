import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronRight, Copy, FileIcon, ImageIcon, PlaySquare, Sparkles, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssistantNameRow } from "@/components/AssistantNameRow";
import { CliAppMentionText } from "@/components/CliAppMentionText";
import { ImageLightbox } from "@/components/ImageLightbox";
import { MarkdownText, preloadMarkdownText } from "@/components/MarkdownText";
import { isLiveArrival } from "@/lib/media";
import {
  buildTokenUsageTitle,
  displayCacheRead,
  displayCompletionOut,
  displayPromptIn,
} from "@/lib/turn-usage";
import { cn, formatTokenCount } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import { formatTurnLatency } from "@/lib/format";
import { useBotIdentity } from "@/contexts/BotIdentityContext";
import type {
  CliAppInfo,
  McpPresetInfo,
  UICliAppAttachment,
  UIMcpPresetAttachment,
  UIImage,
  UIMediaAttachment,
  UIMessage,
} from "@/lib/types";
import { extractCaptionBlocks } from "@/lib/vision-caption";

/**
 * Electron 渲染进程是 file:// origin，/api/... 相对路径需要拼上网关绝对地址才能发起 HTTP 请求。
 * data: URL 和已经是绝对地址的 URL 原样返回。
 */
export function resolveMediaUrl(url: string | undefined, apiBase: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  const base = apiBase.replace(/\/$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

interface MessageBubbleProps {
  message: UIMessage;
  /** When false, hide the assistant reply copy button (mid-turn text before more agent activity). Default true. */
  showAssistantCopyAction?: boolean;
  cliApps?: CliAppInfo[];
  mcpPresets?: McpPresetInfo[];
}

/**
 * Render a single message. Following agent-chat-ui: user turns are a rounded
 * "pill" right-aligned with a muted fill; assistant turns render as bare
 * markdown so prose/code read like a document rather than a chat bubble.
 * Each turn fades+slides in for a touch of motion polish.
 *
 * Trace rows (tool-call hints, progress breadcrumbs) render as a subdued
 * collapsible group so intermediate steps never masquerade as replies.
 */
export function MessageBubble({
  message,
  showAssistantCopyAction = true,
  cliApps = [],
  mcpPresets = [],
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const baseAnim = "animate-in fade-in-0 slide-in-from-bottom-1 duration-300";
  const mentionCliApps = useMemo(
    () => mergeCliMentionApps(cliApps, message.cliApps),
    [cliApps, message.cliApps],
  );
  const mentionMcpPresets = useMemo(
    () => mergeMcpMentionPresets(mcpPresets, message.mcpPresets),
    [mcpPresets, message.mcpPresets],
  );

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const onCopyAssistantReply = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetRef.current = null;
      }, 1_500);
    });
  }, [message.content]);

  if (message.kind === "trace") {
    return <TraceGroup message={message} animClass={baseAnim} />;
  }

  if (message.role === "user") {
    const images = message.images ?? [];
    const media = message.media ?? [];
    const hasImages = images.length > 0;
    const hasMedia = media.length > 0;
    const { displayText, captionText } = extractCaptionBlocks(message.content);
    const hasText = displayText.trim().length > 0;
    return (
      <div
        className={cn(
          "group ml-auto flex max-w-[min(85%,36rem)] flex-col items-end gap-1.5",
          baseAnim,
        )}
      >
        {hasImages ? <UserImages images={images} align="right" /> : null}
        {!hasImages && hasMedia ? (
          <MessageMedia media={media} align="right" />
        ) : null}
        {(hasText || captionText) ? (
          <div
            className={cn(
              "ml-auto w-fit rounded-[18px_18px_4px_18px] bg-gradient-to-br from-primary to-primary/80 chat-user-bubble",
              "text-left break-words overflow-hidden",
            )}
          >
            {hasText ? (
              <p className="px-4 py-2 text-[16px]/[1.75] whitespace-pre-wrap text-primary-foreground">
                <CliAppMentionText
                  text={displayText}
                  cliApps={mentionCliApps}
                  mcpPresets={mentionMcpPresets}
                />
              </p>
            ) : null}
            {captionText ? (
              <div className={cn("px-2 pb-2", hasText && "border-t border-primary-foreground/20")}>
                <CaptionBubble
                  text={captionText}
                  inverted
                  streaming={!!message.visionCaptionStreaming}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const empty = message.content.trim().length === 0;
  const media = message.media ?? [];
  const reasoning = message.role === "assistant" ? message.reasoning ?? "" : "";
  const reasoningStreaming = !!(message.role === "assistant" && message.reasoningStreaming);
  const hasReasoning = reasoning.length > 0 || reasoningStreaming;

  const showAssistantActions = message.role === "assistant" && !message.isStreaming && !empty;
  const showCopyButton = showAssistantCopyAction && showAssistantActions;
  const latencyMs = message.latencyMs;
  const usage = message.role === "assistant" ? message.usage : undefined;
  const messageTs = message.role === "assistant" ? message.messageTs : undefined;
  const footerCondition = message.role === "assistant" && !message.isStreaming && (!empty || hasReasoning || media.length > 0);
  const showLatencyFooter = footerCondition && latencyMs != null;
  const showUsageFooter = footerCondition && usage != null;
  const showTimestampFooter = footerCondition && messageTs != null;
  const showAssistantFooterRow = showCopyButton || showLatencyFooter || showUsageFooter || showTimestampFooter;

  const isTypingOnly = empty && message.isStreaming && !hasReasoning;
  const { botName, botIcon, botAvatarUrl } = useBotIdentity();
  const { apiBase } = useClient();

  if (isTypingOnly) {
    return (
      <div className={cn("flex w-full gap-2 text-[15px]", baseAnim)} style={{ lineHeight: "var(--cjk-line-height)" }}>
        <div className="flex w-10 flex-none items-start pt-0.5">
          <BotAvatarWithFallback name={botName} icon={botIcon} avatarUrl={resolveMediaUrl(botAvatarUrl ?? undefined, apiBase)} />
        </div>
        <div className="min-w-0 flex-1">
          <AssistantNameRow botName={botName} message={message} />
          <div className="rounded-[18px_18px_18px_4px] border border-border chat-ai-bubble px-4 py-3 [letter-spacing:0.3px]">
            <TypingDots />
          </div>
        </div>
      </div>
    );
  }

  if (empty && message.isStreaming) {
    return (
      <div className={cn("flex w-full gap-2 text-[15px]", baseAnim)} style={{ lineHeight: "var(--cjk-line-height)" }}>
        <div className="flex w-10 flex-none items-start pt-0.5">
          <BotAvatarWithFallback name={botName} icon={botIcon} avatarUrl={resolveMediaUrl(botAvatarUrl ?? undefined, apiBase)} />
        </div>
        <div className="min-w-0 flex-1">
          <AssistantNameRow botName={botName} message={message} />
          <div className="rounded-[18px_18px_18px_4px] border border-border chat-ai-bubble px-4 py-3 [letter-spacing:0.3px]">
            <ReasoningBubble text={reasoning} streaming={reasoningStreaming} hasBodyBelow={false} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex w-full gap-2 text-[15px]", baseAnim)} style={{ lineHeight: "var(--cjk-line-height)" }}>
      {/* 左列：头像，靠顶部对齐 */}
      <div className="flex w-10 flex-none items-start pt-0.5">
        <BotAvatarWithFallback name={botName} icon={botIcon} avatarUrl={resolveMediaUrl(botAvatarUrl ?? undefined, apiBase)} />
      </div>
      {/* 右列：名字 + 气泡 + footer */}
      <div className="min-w-0 flex-1">
        <AssistantNameRow botName={botName} message={message} />
        <div className="rounded-[18px_18px_18px_4px] border border-border chat-ai-bubble px-4 py-3 [letter-spacing:0.3px]">
          {hasReasoning ? (
            <ReasoningBubble text={reasoning} streaming={reasoningStreaming} hasBodyBelow={!empty} />
          ) : null}
          <MarkdownText streaming={!!message.isStreaming}>{message.content}</MarkdownText>
        </div>
        {media.length > 0 ? (
          <MessageMedia media={media} align="left" autoPlayAudio={isLiveArrival(message.createdAt)} />
        ) : null}
        {showAssistantFooterRow ? (
          <div className="mt-2 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            {showCopyButton ? (
              <button
                type="button"
                onClick={onCopyAssistantReply}
                aria-label={copied ? t("message.copiedReply") : t("message.copyReply")}
                title={copied ? t("message.copiedReply") : t("message.copyReply")}
                className={cn(
                  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  "transition-colors hover:bg-muted/55 hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
              </button>
            ) : null}
            {showTimestampFooter ? (
              <MessageTimestamp ts={messageTs!} />
            ) : null}
            {showUsageFooter ? (
              <TokenUsageFooter usage={usage!} />
            ) : null}
            {showLatencyFooter ? (
              <span
                className="text-[11px] leading-none text-muted-foreground/70 tabular-nums"
                title={t("message.turnLatencyTitle")}
              >
                {formatTurnLatency(latencyMs)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function mergeMcpMentionPresets(
  presets: McpPresetInfo[],
  attachments: UIMcpPresetAttachment[] | undefined,
): McpPresetInfo[] {
  if (!attachments?.length) return presets;
  const byName = new Map(presets.map((preset) => [preset.name.toLowerCase(), preset]));
  for (const attachment of attachments) {
    const name = attachment.name?.trim();
    if (!name) continue;
    const existing = byName.get(name.toLowerCase());
    byName.set(name.toLowerCase(), {
      name,
      display_name: attachment.display_name || existing?.display_name || name,
      category: attachment.category || existing?.category || "mcp",
      description: existing?.description || "",
      docs_url: existing?.docs_url || "",
      transport: attachment.transport || existing?.transport || "mcp",
      requires: existing?.requires || "",
      note: existing?.note || "",
      install_supported: existing?.install_supported ?? true,
      installed: true,
      configured: attachment.configured ?? existing?.configured ?? true,
      available: existing?.available ?? true,
      status: attachment.status || existing?.status || "configured",
      logo_url: attachment.logo_url ?? existing?.logo_url ?? null,
      brand_color: attachment.brand_color ?? existing?.brand_color ?? null,
      required_fields: existing?.required_fields || [],
      connection_summary: existing?.connection_summary || "",
    });
  }
  return Array.from(byName.values());
}

function mergeCliMentionApps(
  cliApps: CliAppInfo[],
  attachments: UICliAppAttachment[] | undefined,
): CliAppInfo[] {
  if (!attachments?.length) return cliApps;
  const byName = new Map(cliApps.map((app) => [app.name.toLowerCase(), app]));
  for (const attachment of attachments) {
    const name = attachment.name?.trim();
    if (!name) continue;
    const existing = byName.get(name.toLowerCase());
    byName.set(name.toLowerCase(), {
      name,
      display_name: attachment.display_name || existing?.display_name || name,
      category: attachment.category || existing?.category || "cli",
      description: existing?.description || "",
      requires: existing?.requires || "",
      source: existing?.source || "attached",
      entry_point: attachment.entry_point || existing?.entry_point || "",
      install_supported: existing?.install_supported ?? true,
      installed: true,
      available: existing?.available ?? true,
      status: existing?.status || "installed",
      logo_url: attachment.logo_url ?? existing?.logo_url ?? null,
      brand_color: attachment.brand_color ?? existing?.brand_color ?? null,
      skill_installed: existing?.skill_installed ?? true,
    });
  }
  return Array.from(byName.values());
}

export function MessageMedia({
  media,
  align,
  autoPlayAudio = false,
}: {
  media: UIMediaAttachment[];
  align: "left" | "right";
  /** 仅当消息为本次会话直播到达时为 true，决定音频是否自动播放。 */
  autoPlayAudio?: boolean;
}) {
  if (media.length === 0) return null;
  const images: UIImage[] = [];
  const nonImages: UIMediaAttachment[] = [];
  for (const item of media) {
    if (item.kind === "image") {
      images.push({ url: item.url, name: item.name });
    } else {
      nonImages.push(item);
    }
  }

  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap gap-2",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      {images.length > 0 ? (
        <UserImages images={images} align={align} size={align === "left" ? "large" : "compact"} />
      ) : null}
      {nonImages.map((item, i) => (
        <MediaCell key={`${item.url ?? item.name ?? item.kind}-${i}`} media={item} autoPlay={autoPlayAudio} />
      ))}
    </div>
  );
}

// 已自动播放过的音频 URL：避免视图重挂载（切换 Tab 再切回等）时重复自动播放。
const autoPlayedAudio = new Set<string>();

function AudioCell({ media, autoPlay = false }: { media: UIMediaAttachment; autoPlay?: boolean }) {
  const { t } = useTranslation();
  const { apiBase } = useClient();
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Electron 是 file:// origin，相对路径需要拼上 gateway 绝对地址
  const resolvedUrl = resolveMediaUrl(media.url, apiBase);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !autoPlay || !resolvedUrl) return;
    // 仅对「直播到达且尚未自动播放过」的音频自动播放一次。
    if (autoPlayedAudio.has(resolvedUrl)) return;
    autoPlayedAudio.add(resolvedUrl);
    // autoplay 被浏览器策略拒绝不视为失败：保留 controls 让用户手动播放。
    el.play().catch(() => {});
  }, [autoPlay, resolvedUrl]);

  if (failed || !resolvedUrl) {
    return (
      <a
        href={resolvedUrl ?? undefined}
        download={media.name ?? t("message.audioAttachment", { defaultValue: "Audio attachment" })}
        aria-label={t("message.audioAttachment", { defaultValue: "Audio attachment" })}
        className="flex max-w-[18rem] items-center gap-2 rounded-[14px] border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground hover:underline"
      >
        <PlaySquare className="h-4 w-4 flex-none" aria-hidden />
        <span className="truncate">{media.name ?? t("message.audioAttachment", { defaultValue: "Audio attachment" })}</span>
      </a>
    );
  }

  return (
    <figure className="audio-attachment w-full max-w-[min(100%,28rem)]">
      <audio
        ref={audioRef}
        src={resolvedUrl}
        controls
        preload="auto"
        onError={() => setFailed(true)}
        className="audio-attachment-player w-full"
        aria-label={media.name ? `${t("message.audioAttachment", { defaultValue: "Audio attachment" })}: ${media.name}` : t("message.audioAttachment", { defaultValue: "Audio attachment" })}
      />
      {media.name ? (
        <figcaption className="truncate px-1 pt-1 text-[11.5px] text-muted-foreground">
          {media.name}
        </figcaption>
      ) : null}
    </figure>
  );
}

function MediaCell({ media, autoPlay = false }: { media: UIMediaAttachment; autoPlay?: boolean }) {
  const { t } = useTranslation();
  const { apiBase } = useClient();
  const hasUrl = typeof media.url === "string" && media.url.length > 0;
  const resolvedUrl = resolveMediaUrl(media.url, apiBase);

  if (media.kind === "audio") {
    return <AudioCell media={media} autoPlay={autoPlay} />;
  }

  if (media.kind === "video" && hasUrl) {
    return (
      <figure className="max-w-[min(100%,32rem)] overflow-hidden rounded-[14px] border border-border/60 bg-muted/40">
        <video
          src={resolvedUrl}
          controls
          preload="metadata"
          className="block max-h-[26rem] w-full bg-black"
          aria-label={media.name ? `${t("message.videoAttachment", { defaultValue: "Video attachment" })}: ${media.name}` : t("message.videoAttachment", { defaultValue: "Video attachment" })}
        />
        {media.name ? (
          <figcaption className="truncate px-3 py-1.5 text-[11.5px] text-muted-foreground">
            {media.name}
          </figcaption>
        ) : null}
      </figure>
    );
  }

  const label =
    media.kind === "video"
      ? t("message.videoAttachment", { defaultValue: "Video attachment" })
      : t("message.fileAttachment", { defaultValue: "File attachment" });
  const Icon = media.kind === "video" ? PlaySquare : FileIcon;

  const inner = (
    <>
      <Icon className="h-4 w-4 flex-none" aria-hidden />
      <span className="truncate">{media.name ?? label}</span>
    </>
  );

  if (hasUrl) {
    return (
      <a
        href={resolvedUrl}
        download={media.name ?? label}
        title={media.name ?? undefined}
        aria-label={label}
        className="flex max-w-[18rem] items-center gap-2 rounded-[14px] border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground hover:underline"
      >
        {inner}
      </a>
    );
  }

  return (
    <div
      className="flex max-w-[18rem] items-center gap-2 rounded-[14px] border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      title={media.name ?? undefined}
      aria-label={label}
    >
      {inner}
    </div>
  );
}

/**
 * Right-aligned preview row for images attached to a user turn.
 *
 * Visual follows agent-chat-ui: a single wrapping row of fixed-size square
 * thumbnails that stay modest next to the text pill regardless of how many
 * images are attached.
 *
 * The URL is expected to be a self-contained ``data:`` URL (the Composer
 * hands the normalized base64 payload to the optimistic bubble so that the
 * preview survives React StrictMode double-mount — blob URLs would be
 * revoked by the Composer's cleanup before remount). Historical replays
 * have no URL (the backend strips data URLs before persisting), so we
 * render a labelled placeholder tile instead of a broken ``<img>``.
 */
function UserImages({
  images,
  align = "right",
  size = "compact",
}: {
  images: UIImage[];
  align?: "left" | "right";
  size?: "compact" | "large";
}) {
  const { t } = useTranslation();
  const { apiBase } = useClient();
  // Only real-URL images can open in the lightbox; historical-replay
  // placeholders (no URL) have nothing to zoom into.
  const viewableImages: UIImage[] = [];
  const originalToViewable = new Map<number, number>();
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    if (typeof img.url !== "string" || img.url.length === 0) continue;
    originalToViewable.set(i, viewableImages.length);
    viewableImages.push({ ...img, url: resolveMediaUrl(img.url, apiBase) });
  }

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-end gap-2",
          size === "large" && "gap-3",
          align === "right" ? "ml-auto justify-end" : "mr-auto justify-start",
        )}
      >
        {images.map((img, i) => (
          <UserImageCell
            key={`${img.url ?? "placeholder"}-${i}`}
            image={img}
            size={size}
            placeholderLabel={t("message.imageAttachment")}
            openLabel={t("lightbox.open")}
            onOpen={
              originalToViewable.has(i)
                ? () => setLightboxIndex(originalToViewable.get(i)!)
                : undefined
            }
          />
        ))}
      </div>
      <ImageLightbox
        images={viewableImages}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null);
        }}
      />
    </>
  );
}

function UserImageCell({
  image,
  size,
  placeholderLabel,
  openLabel,
  onOpen,
}: {
  image: UIImage;
  size: "compact" | "large";
  placeholderLabel: string;
  openLabel: string;
  onOpen?: () => void;
}) {
  const { apiBase } = useClient();
  // Electron 渲染进程是 file:// origin，相对路径 /api/... 需要拼上网关绝对地址。
  const resolvedUrl = resolveMediaUrl(image.url, apiBase);
  const hasUrl = typeof resolvedUrl === "string" && resolvedUrl.length > 0;
  const tileClasses = cn(
    "relative overflow-hidden border border-border/60 bg-muted/40",
    size === "large"
      ? "w-[min(100%,34rem)] rounded-[20px] bg-transparent"
      : "h-24 w-24 rounded-[14px]",
    "shadow-[0_6px_18px_-14px_rgba(0,0,0,0.45)]",
  );

  if (hasUrl && onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={image.name ? `${openLabel}: ${image.name}` : openLabel}
        className={cn(
          tileClasses,
          "block cursor-zoom-in p-0 transition-transform duration-150 motion-reduce:transition-none",
          "hover:scale-[1.01] hover:ring-2 hover:ring-primary/25",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        )}
      >
        <img
          src={resolvedUrl}
          alt={image.name ?? ""}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={cn(
            "block",
            size === "large"
              ? "h-auto max-h-[36rem] w-full rounded-[inherit] object-contain"
              : "h-full w-full object-cover",
          )}
        />
      </button>
    );
  }

  return (
    <div className={tileClasses} title={image.name ?? undefined}>
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-[11px] text-muted-foreground"
        aria-label={placeholderLabel}
      >
        <ImageIcon className="h-4 w-4 flex-none" aria-hidden />
        <span className="line-clamp-2 text-center leading-tight">
          {image.name ?? placeholderLabel}
        </span>
      </div>
    </div>
  );
}

export function BotAvatarWithFallback({
  name,
  icon,
  avatarUrl,
}: {
  name: string;
  icon: string;
  avatarUrl: string | undefined;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const fallback = icon || (name ? name[0].toUpperCase() : "B");
  const showImg = !!avatarUrl && !imgFailed;
  return (
    <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-muted text-[13px] font-medium text-muted-foreground">
      {showImg ? (
        <img
          src={avatarUrl}
          alt={name}
          className="h-9 w-9 rounded-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

/** Pre-token-arrival placeholder: three bouncing dots. */
function TypingDots() {
  const { t } = useTranslation();
  return (
    <span
      aria-label={t("message.assistantTyping")}
      className="inline-flex items-center gap-1 py-1"
    >
      <Dot delay="0ms" />
      <Dot delay="150ms" />
      <Dot delay="300ms" />
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      style={{ animationDelay: delay }}
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60",
        "animate-bounce",
      )}
    />
  );
}

function formatMessageTimestamp(ts: string | number): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${mo}-${dd} ${hh}:${mm}:${ss}`;
}

function MessageTimestamp({ ts }: { ts: string | number }) {
  const formatted = formatMessageTimestamp(ts);
  if (!formatted) return null;
  return (
    <span className="text-[11px] leading-none text-muted-foreground/50 tabular-nums" title={String(ts)}>
      {formatted}
    </span>
  );
}

function TokenUsageFooter({ usage }: { usage: NonNullable<UIMessage["usage"]> }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  const promptIn = displayPromptIn(usage);
  const completionOut = displayCompletionOut(usage);
  const cacheRead = displayCacheRead(usage);

  if (promptIn > 0) {
    parts.push(`↑${formatTokenCount(promptIn)}`);
  }
  if (completionOut > 0) {
    parts.push(`↓${formatTokenCount(completionOut)}`);
  }
  if (cacheRead > 0) {
    parts.push(`R${formatTokenCount(cacheRead)}`);
  }
  if (usage.context_pct != null && usage.context_pct >= 0) {
    parts.push(`${usage.context_pct}% ctx`);
  }

  if (parts.length === 0) return null;

  return (
    <span
      className="text-[11px] leading-none text-muted-foreground/60 tabular-nums"
      title={buildTokenUsageTitle(usage, t)}
    >
      {parts.join(" ")}
    </span>
  );
}

/** L→R sheen on the glyphs themselves; inactive labels stay solid muted text. */
export function StreamingLabelSheen({
  children,
  active,
  className,
}: {
  children: ReactNode;
  active: boolean;
  className?: string;
}) {
  const sheenText =
    typeof children === "string" || typeof children === "number"
      ? String(children)
      : undefined;
  return (
    <span className={cn("block min-w-0 overflow-hidden py-px", className)}>
      <span
        data-sheen-text={active ? sheenText : undefined}
        className={cn(
          "block w-fit max-w-full truncate font-medium leading-normal",
          active ? "streaming-text-sheen" : "text-muted-foreground",
        )}
      >
        {children}
      </span>
    </span>
  );
}

interface ReasoningBubbleProps {
  text: string;
  streaming: boolean;
  hasBodyBelow: boolean;
  /** When true, skip the slide-in wrapper (used inside ``AgentActivityCluster``). */
  embeddedInCluster?: boolean;
}

/**
 * Subordinate "thinking" trace shown above an assistant turn.
 *
 * Lifecycle:
 *   - While ``streaming`` is true (``reasoning_delta`` frames still arriving),
 *     the bubble defaults to open and the header shows a sheen + pulse so
 *     the user sees the model "thinking out loud" in real time.
 *   - Expanded reasoning uses the same Markdown pipeline as assistant replies
 *     (deferred while streaming to reduce parser thrash), so headings and
 *     emphasis render instead of leaking raw ``###`` / ``**``.
 *   - On ``reasoning_end`` the bubble auto-collapses for prose density —
 *     the user can re-expand to inspect the chain of thought. The local
 *     toggle persists once the user interacts.
 */
export function ReasoningBubble({
  text,
  streaming,
  hasBodyBelow,
  embeddedInCluster = false,
}: ReasoningBubbleProps) {
  const { t } = useTranslation();
  const [userToggled, setUserToggled] = useState(false);
  const [openLocal, setOpenLocal] = useState(true);
  const open = userToggled ? openLocal : streaming;
  const onToggle = () => {
    setUserToggled(true);
    setOpenLocal((v) => (userToggled ? !v : !open));
  };
  useEffect(() => {
    if (open && text.length > 0) {
      preloadMarkdownText();
    }
  }, [open, text.length]);
  return (
    <div
      className={cn(
        "w-full",
        !embeddedInCluster && "animate-in fade-in-0 slide-in-from-top-1 duration-200",
        hasBodyBelow && "mb-2",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5",
          "text-xs text-muted-foreground transition-colors hover:bg-muted/45",
        )}
        aria-expanded={open}
        aria-live={streaming ? "polite" : undefined}
      >
        <Sparkles
          className={cn("h-3.5 w-3.5", streaming && "animate-pulse")}
          aria-hidden
        />
        <StreamingLabelSheen active={streaming} className="min-w-0 flex-1 text-left">
          {streaming
            ? t("message.reasoningStreaming", { defaultValue: "Thinking…" })
            : t("message.reasoning", { defaultValue: "Thinking" })}
        </StreamingLabelSheen>
        <ChevronRight
          aria-hidden
          className={cn(
            "ml-auto h-3.5 w-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open && text.length > 0 && (
        <div
          className={cn(
            "mt-1 min-w-0 border-l border-muted-foreground/20 pl-3",
            !embeddedInCluster && "animate-in fade-in-0 slide-in-from-top-1 duration-200",
          )}
        >
          <MarkdownText
            streaming={streaming}
            className={cn(
              "text-[12.5px] italic text-muted-foreground/88",
              "prose-p:my-1.5 prose-li:my-0.5",
              "prose-headings:mt-2 prose-headings:mb-1 prose-headings:font-medium",
              "prose-headings:text-muted-foreground/92 prose-strong:text-muted-foreground",
              "prose-h1:text-[15px] prose-h2:text-[13.5px] prose-h3:text-[12.5px] prose-h4:text-[12px]",
              "prose-a:text-muted-foreground/95 prose-a:underline hover:prose-a:opacity-90",
              "prose-code:text-[0.92em]",
            )}
          >
            {text}
          </MarkdownText>
        </div>
      )}
    </div>
  );
}

/**
 * 用户消息中的图片识别结果折叠块。
 * 默认收起，避免与图片缩略图重复展示。
 * 单图时后端加了 `图片描述：\n` 前缀供 LLM 理解，展示前剥掉。
 */
function CaptionBubble({
  text,
  inverted = false,
  streaming = false,
}: {
  text: string;
  inverted?: boolean;
  streaming?: boolean;
}) {
  const { t } = useTranslation();
  const [userToggled, setUserToggled] = useState(false);
  const [openLocal, setOpenLocal] = useState(true);
  const open = userToggled ? openLocal : streaming;
  const onToggle = () => {
    setUserToggled(true);
    setOpenLocal((v) => (userToggled ? !v : !open));
  };
  const SINGLE_PREFIX = "图片描述：";
  const displayText = text.trimStart().startsWith(SINGLE_PREFIX)
    ? text.trimStart().slice(SINGLE_PREFIX.length)
    : text;
  return (
    <div className="w-full animate-in fade-in-0 slide-in-from-top-1 duration-200">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5",
          "text-xs transition-colors",
          inverted
            ? "text-primary-foreground/70 hover:bg-primary-foreground/10"
            : "text-muted-foreground hover:bg-muted/45",
        )}
        aria-expanded={open}
      >
        <ImageIcon className={cn("h-3.5 w-3.5", streaming && "animate-pulse")} aria-hidden />
        <StreamingLabelSheen
          active={streaming}
          className={cn("min-w-0 flex-1 text-left", inverted && streaming && "text-primary-foreground/85")}
        >
          {streaming
            ? t("message.visionCaptionStreaming", { defaultValue: "正在识别图片…" })
            : t("message.visionCaption", { defaultValue: "图片识别结果" })}
        </StreamingLabelSheen>
        <ChevronRight
          aria-hidden
          className={cn(
            "ml-auto h-3.5 w-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
        <div
          aria-live={streaming ? "polite" : undefined}
          aria-atomic="false"
          hidden={!open}
          className={cn(
            "mt-1 min-w-0 animate-in fade-in-0 slide-in-from-top-1 duration-200 border-l pl-3",
            inverted ? "border-primary-foreground/20" : "border-muted-foreground/20",
          )}
        >
          <MarkdownText
            className={cn(
              "text-[12.5px] italic break-words",
              inverted
                ? "prose-invert text-primary-foreground/80 prose-headings:text-primary-foreground prose-strong:text-primary-foreground"
                : "text-muted-foreground/88",
              "prose-p:my-1.5 prose-li:my-0.5",
            )}
          >
          {displayText}
        </MarkdownText>
      </div>
    </div>
  );
}

interface TraceGroupProps {
  message: UIMessage;
  animClass: string;
}

/**
 * Collapsible group of tool-call / progress breadcrumbs. Defaults to
 * collapsed because tool traces are supporting evidence, not the answer.
 * A single click expands the exact calls when the user wants details.
 */
export function TraceGroup({ message, animClass }: TraceGroupProps) {
  const { t } = useTranslation();
  const lines = message.traces ?? [message.content];
  const count = lines.length;
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("w-full", animClass)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5",
          "text-xs text-muted-foreground transition-colors hover:bg-muted/45",
        )}
        aria-expanded={open}
      >
        <Wrench className="h-3.5 w-3.5" aria-hidden />
        <span className="font-medium">
          {count === 1
            ? t("message.toolSingle")
            : t("message.toolMany", { count })}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            "ml-auto h-3.5 w-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ul
          className={cn(
            "mt-1 space-y-0.5 border-l border-muted-foreground/20 pl-3",
            "animate-in fade-in-0 slide-in-from-top-1 duration-200",
          )}
        >
          {lines.map((line, i) => (
            <li
              key={i}
              className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted-foreground/90"
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
