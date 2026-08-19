export type WorkspaceEntryKind = "file" | "dir";

export interface WorkspaceListEntry {
  name: string;
  kind: WorkspaceEntryKind;
}

export interface WorkspaceListPayload {
  path: string;
  entries: WorkspaceListEntry[];
  truncated?: boolean;
}

export interface WorkspaceReadTextPayload {
  path: string;
  kind: "text";
  content: string;
  encoding: "utf-8";
  size_bytes?: number;
  truncated?: boolean;
  frontmatter?: Record<string, unknown>;
}

export interface WorkspaceReadImagePayload {
  path: string;
  kind: "image";
  mime_type: string;
  content_base64: string;
  size_bytes?: number;
  truncated?: boolean;
}

export type WorkspaceReadPayload = WorkspaceReadTextPayload | WorkspaceReadImagePayload;

export type WorkspacePreviewMode = "markdown" | "code" | "image" | "unsupported";

const CODE_EXTENSION_LANGUAGES: Record<string, string> = {
  json: "json",
  jsonl: "json",
  py: "python",
  python: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  html: "html",
  css: "css",
  sql: "sql",
  rs: "rust",
  go: "go",
};

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
]);

/** 超过此大小的 JSONL 跳过逐行格式化，避免主线程卡顿。 */
export const MAX_JSONL_FORMAT_BYTES = 512 * 1024;

const UNSUPPORTED_EXTENSIONS = new Set([
  "svg",
  "pdf", "zip", "gz", "tar", "bz2", "xz", "7z", "rar",
  "exe", "dll", "so", "dylib", "bin", "wasm",
  "mp3", "mp4", "wav", "avi", "mov", "mkv",
  "woff", "woff2", "ttf", "otf", "eot",
  "pyc", "pyo", "class", "o", "a",
]);

export function fileExtension(path: string): string {
  const base = path.split("/").pop() ?? path;
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return "";
  return base.slice(idx + 1).toLowerCase();
}

export function previewModeForPath(path: string): WorkspacePreviewMode {
  const ext = fileExtension(path);
  if (!ext) return "code";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (UNSUPPORTED_EXTENSIONS.has(ext)) return "unsupported";
  return "code";
}

export function codeLanguageForPath(path: string): string {
  const ext = fileExtension(path);
  return CODE_EXTENSION_LANGUAGES[ext] ?? "text";
}

export function formatJsonIfPossible(content: string): { content: string; language: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { content, language: codeLanguageForPath("file.json") };
  }
  try {
    return {
      content: `${JSON.stringify(JSON.parse(content), null, 2)}\n`,
      language: "json",
    };
  } catch {
    return { content, language: "json" };
  }
}

/** JSONL：逐行 parse + indent，避免单行过长；解析失败的行保持原样。 */
export function formatJsonlIfPossible(content: string): { content: string; language: string } {
  if (content.length > MAX_JSONL_FORMAT_BYTES) {
    return { content, language: "json" };
  }
  const lines = content.split(/\r?\n/);
  const formatted = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return line;
    }
  });
  return {
    content: formatted.join("\n\n"),
    language: "json",
  };
}

export function formatStructuredJsonContent(
  path: string,
  content: string,
): { content: string; language: string } {
  const ext = fileExtension(path);
  if (ext === "jsonl") return formatJsonlIfPossible(content);
  if (ext === "json") return formatJsonIfPossible(content);
  return { content, language: codeLanguageForPath(path) };
}

export function workspaceImageDataUrl(payload: WorkspaceReadImagePayload): string {
  return `data:${payload.mime_type};base64,${payload.content_base64}`;
}

const OBSIDIAN_IMAGE_EMBED_RE = /!\[\[([^\]|#]+\.(?:png|jpe?g|gif|webp|bmp|ico))(?:#[^\]|]*)?(?:\|(\d+)(?:x(\d+))?)?\]\]/gi;
export const DIARY_IMAGE_URL_PREFIX = "diary-image:";

export interface ObsidianImageEmbed {
  name: string;
  width?: number;
  height?: number;
}

export function obsidianImageEmbeds(markdown: string): ObsidianImageEmbed[] {
  const embeds = new Map<string, ObsidianImageEmbed>();
  for (const match of markdown.matchAll(OBSIDIAN_IMAGE_EMBED_RE)) {
    const name = match[1].trim();
    const width = match[2] ? Number(match[2]) : undefined;
    const height = match[3] ? Number(match[3]) : undefined;
    embeds.set(name, { name, ...(width ? { width } : {}), ...(height ? { height } : {}) });
  }
  return [...embeds.values()];
}

export function obsidianImageName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\[\[([^\]|#]+\.(?:png|jpe?g|gif|webp|bmp|ico))(?:#[^\]|]*)?(?:\|\d+(?:x\d+)?)?\]\]$/i.exec(
    value.trim(),
  );
  return match?.[1].trim() || null;
}

export function rewriteObsidianImages(
  markdown: string,
): string {
  return markdown.replace(
    OBSIDIAN_IMAGE_EMBED_RE,
    (_original, rawName: string, rawWidth?: string, rawHeight?: string) => {
      const name = rawName.trim();
      const size = rawWidth
        ? ` \"size=${rawWidth}${rawHeight ? `x${rawHeight}` : ""}\"`
        : "";
      return `![${name}](${DIARY_IMAGE_URL_PREFIX}${encodeURIComponent(name)}${size})`;
    },
  );
}

export function joinWorkspacePath(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** 返回文件路径的所有祖先目录，用于恢复树展开状态。 */
export function workspaceAncestorDirs(filePath: string): string[] {
  const parts = filePath.split("/");
  if (parts.length <= 1) return [];
  const dirs = parts.slice(0, -1);
  const result: string[] = [];
  for (let i = 1; i <= dirs.length; i++) {
    result.push(dirs.slice(0, i).join("/"));
  }
  return result;
}

export function todayDiaryPath(timeZone?: string | null, now = new Date()): string {
  const format = (zone?: string) => new Intl.DateTimeFormat("en-CA", {
    ...(zone ? { timeZone: zone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone || undefined);
  } catch {
    parts = format();
  }
  const value = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((part) => part.type === type)?.value ?? ""
  );
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()
  ];
  return `${year}/${month}/${year}-${month}-${day} ${weekday}.md`;
}
