import type { UIMediaAttachment, UIMediaKind } from "@/lib/types";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".3gp",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".aac",
  ".m4a",
  ".weba",
  ".flac",
  ".opus",
]);

function cleanPath(value: string): string {
  return value.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
}

function extensionOf(value?: string): string {
  if (!value) return "";
  const path = cleanPath(value);
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot);
}

export function inferMediaKind(media: { url?: string; name?: string }): UIMediaKind {
  const url = media.url ?? "";
  if (url.startsWith("data:image/")) return "image";
  if (url.startsWith("data:video/")) return "video";
  if (url.startsWith("data:audio/")) return "audio";

  const ext = extensionOf(media.name) || extensionOf(url);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "file";
}

export function toMediaAttachment(media: {
  url?: string;
  name?: string;
  kind?: UIMediaKind;
}): UIMediaAttachment {
  return {
    kind: media.kind ?? inferMediaKind(media),
    url: media.url,
    name: media.name,
  };
}

/**
 * 本次渲染会话的启动时间戳（ms）。
 * 历史回放（seed）的消息 createdAt 为过去的时间戳，直播到达的消息 createdAt 取自 Date.now()，
 * 因此 createdAt 晚于此基准即视为「本次会话内直播到达」。仅这类音频才自动播放。
 */
export const RENDER_SESSION_START = Date.now();

/** 判断一条消息是否为本次会话内「直播」到达（用于决定音频是否自动播放）。 */
export function isLiveArrival(createdAt: number): boolean {
  return createdAt > RENDER_SESSION_START;
}

