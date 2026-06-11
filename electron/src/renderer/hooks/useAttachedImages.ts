import { useCallback, useEffect, useRef, useState } from "react";

import {
  IMAGE_WORKER_MIMES,
  inferAttachmentKind,
  mimeForAttachment,
  type AttachmentKind,
} from "@/lib/attachmentTypes";
import { encodeImage, type EncodeFailure } from "@/lib/imageEncode";

/** Lifecycle stages of one attachment:
 *
 * - ``encoding``  — posted to the Worker / FileReader; chip shows a spinner
 * - ``ready``     — ``dataUrl`` available; safe to submit
 * - ``error``     — validation / decode failure; chip shows inline error
 */
export type AttachmentStatus = "encoding" | "ready" | "error";

export interface AttachedImage {
  id: string;
  file: File;
  kind: AttachmentKind;
  /** Optimistic ``blob:`` preview URL; revoked on ``remove`` / ``clear`` /
   * unmount. 文档附件无预览图时为空字符串。 */
  previewUrl: string;
  status: AttachmentStatus;
  /** Populated when ``status === "ready"``. */
  dataUrl?: string;
  /** Size of the final encoded payload (base64 bytes decoded). */
  encodedBytes?: number;
  /** Whether the Worker re-encoded the image to hit the size budget. */
  normalized?: boolean;
  /** Human-readable validation / encoding error when ``status === "error"``. */
  error?: AttachmentError;
}

/** Machine-readable rejection reasons surfaced as inline chip errors.
 *
 * Callers localize these via the ``composer.imageRejected.*`` i18n table. */
export type AttachmentError =
  | "unsupported_type"   // 扩展名不在 extract_documents 白名单
  | "too_many_images"    // 图片数达上限
  | "too_many_attachments" // 总附件数达上限
  | "magic_mismatch"     // extension lies about the real content
  | "decode_failed"      // Worker couldn't decode / re-encode
  | "too_large"          // even after normalization we exceed the budget
  | "io";                // file read failed at the browser layer

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mapEncodeFailure(reason: EncodeFailure["reason"]): AttachmentError {
  switch (reason) {
    case "invalid_mime":
    case "magic_mismatch":
      return "magic_mismatch";
    case "too_large_after_normalize":
      return "too_large";
    case "io":
      return "io";
    case "decode_failed":
    default:
      return "decode_failed";
  }
}

async function readDocumentDataUrl(file: File): Promise<
  | { ok: true; dataUrl: string; bytes: number }
  | { ok: false; reason: AttachmentError }
> {
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  const targetMime = mimeForAttachment(file);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = reader.result;
      if (typeof raw !== "string" || !raw.includes(",")) {
        resolve({ ok: false, reason: "decode_failed" });
        return;
      }
      const base64 = raw.split(",", 2)[1] ?? "";
      let bytes = 0;
      try {
        bytes = atob(base64).length;
      } catch {
        resolve({ ok: false, reason: "decode_failed" });
        return;
      }
      const dataUrl = `data:${targetMime};base64,${base64}`;
      resolve({ ok: true, dataUrl, bytes });
    };
    reader.onerror = () => resolve({ ok: false, reason: "io" });
    reader.readAsDataURL(file);
  });
}

export interface UseAttachedImagesApi {
  images: AttachedImage[];
  /** Enqueue new files. Returns the list of rejected files so the caller can
   * surface inline errors. Files rejected client-side (wrong MIME, limit) are
   * *not* added to ``images`` — only recoverable encoding failures show up as
   * error chips. */
  enqueue: (files: Iterable<File>) => {
    rejected: Array<{ file: File; reason: AttachmentError }>;
  };
  remove: (id: string) => { nextFocusId: string | null };
  /** Revoke every staged blob URL and drop all attachments. Called after a
   * successful submit — the optimistic bubble holds onto an independent
   * ``data:`` URL so tearing down blob previews here is safe. */
  clear: () => void;
  /** ``true`` when at least one attachment is still encoding — Send should wait. */
  encoding: boolean;
  /** ``true`` when we've hit ``MAX_ATTACHMENTS_PER_MESSAGE``. */
  full: boolean;
}

/** Manage the lifecycle of files attached to the Composer.
 *
 * Responsibilities in one place:
 *   - validation (extension whitelist, count cap)
 *   - blob URL creation + revocation
 *   - Worker orchestration for images; FileReader for documents
 *   - focus bookkeeping so keyboard delete doesn't strand the user
 */
export function useAttachedImages(): UseAttachedImagesApi {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const imagesRef = useRef<AttachedImage[]>([]);
  imagesRef.current = images;

  const setEntry = useCallback((id: string, patch: Partial<AttachedImage>) => {
    setImages((prev) => {
      const next = prev.map((img) => (img.id === id ? { ...img, ...patch } : img));
      imagesRef.current = next;
      return next;
    });
  }, []);

  const enqueue = useCallback(
    (files: Iterable<File>) => {
      const rejected: Array<{ file: File; reason: AttachmentError }> = [];
      const toAdd: AttachedImage[] = [];
      let imageSlots =
        MAX_IMAGES_PER_MESSAGE
        - imagesRef.current.filter((item) => item.kind === "image").length;
      let totalSlots = MAX_ATTACHMENTS_PER_MESSAGE - imagesRef.current.length;

      for (const file of files) {
        const kind = inferAttachmentKind(file);
        if (!kind) {
          rejected.push({ file, reason: "unsupported_type" });
          continue;
        }
        if (totalSlots <= 0) {
          rejected.push({ file, reason: "too_many_attachments" });
          continue;
        }
        if (kind === "image") {
          if (!IMAGE_WORKER_MIMES.has(mimeForAttachment(file))) {
            rejected.push({ file, reason: "unsupported_type" });
            continue;
          }
          if (imageSlots <= 0) {
            rejected.push({ file, reason: "too_many_images" });
            continue;
          }
          imageSlots -= 1;
        }
        totalSlots -= 1;
        toAdd.push({
          id: uuid(),
          file,
          kind,
          previewUrl: kind === "image" ? URL.createObjectURL(file) : "",
          status: "encoding",
        });
      }

      if (toAdd.length > 0) {
        const next = [...imagesRef.current, ...toAdd];
        imagesRef.current = next;
        setImages(next);
        for (const entry of toAdd) {
          queueMicrotask(() => {
            if (entry.kind === "image") {
              encodeImage(entry.file).then(
                (result) => {
                  if (result.ok) {
                    setEntry(entry.id, {
                      status: "ready",
                      dataUrl: result.dataUrl,
                      encodedBytes: result.bytes,
                      normalized: result.normalized,
                    });
                  } else {
                    setEntry(entry.id, {
                      status: "error",
                      error: mapEncodeFailure((result as EncodeFailure).reason),
                    });
                  }
                },
                () => {
                  setEntry(entry.id, {
                    status: "error",
                    error: "decode_failed",
                  });
                },
              );
              return;
            }
            readDocumentDataUrl(entry.file).then((result) => {
              if (result.ok) {
                setEntry(entry.id, {
                  status: "ready",
                  dataUrl: result.dataUrl,
                  encodedBytes: result.bytes,
                });
              } else {
                setEntry(entry.id, {
                  status: "error",
                  error: result.reason,
                });
              }
            });
          });
        }
      }
      return { rejected };
    },
    [setEntry],
  );

  const remove = useCallback((id: string) => {
    let nextFocusId: string | null = null;
    setImages((prev) => {
      const idx = prev.findIndex((img) => img.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      if (target.previewUrl) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          // No-op: previewUrl revocation is best-effort.
        }
      }
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      imagesRef.current = next;
      const candidate = next[idx] ?? next[idx - 1];
      nextFocusId = candidate?.id ?? null;
      return next;
    });
    return { nextFocusId };
  }, []);

  const clear = useCallback(() => {
    setImages((prev) => {
      for (const img of prev) {
        if (!img.previewUrl) continue;
        try {
          URL.revokeObjectURL(img.previewUrl);
        } catch {
          // revoke is best-effort
        }
      }
      imagesRef.current = [];
      return [];
    });
  }, []);

  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) {
        if (!img.previewUrl) continue;
        try {
          URL.revokeObjectURL(img.previewUrl);
        } catch {
          // best-effort cleanup on unmount
        }
      }
    };
  }, []);

  const encoding = images.some((img) => img.status === "encoding");
  const full = images.length >= MAX_ATTACHMENTS_PER_MESSAGE;

  return { images, enqueue, remove, clear, encoding, full };
}
