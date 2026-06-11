/** 与 ``nanobot.utils.document.SUPPORTED_EXTENSIONS`` 对齐的附件扩展名白名单。 */

export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

export const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".py",
  ".sh",
]);

export const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
]);

/** 浏览器 ``<input accept>`` 用的扩展名列表。 */
export const ACCEPT_ATTR = [
  ...SUPPORTED_ATTACHMENT_EXTENSIONS,
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
].join(",");

const EXTENSION_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".py": "text/x-python",
  ".sh": "application/x-sh",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type AttachmentKind = "image" | "document";

export function extensionOfFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot).toLowerCase();
}

export function inferAttachmentKind(file: File): AttachmentKind | null {
  const ext = extensionOfFilename(file.name);
  if (!ext || !SUPPORTED_ATTACHMENT_EXTENSIONS.has(ext)) return null;
  if (ext === ".svg" || file.type === "image/svg+xml") return null;
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "document";
}

export function mimeForAttachment(file: File): string {
  const ext = extensionOfFilename(file.name);
  if (file.type && file.type !== "application/octet-stream") return file.type;
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

/** 图片 Worker 仍只接受这四种 MIME。 */
export const IMAGE_WORKER_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
