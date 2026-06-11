import { useCallback, useRef, useState } from "react";

import { inferAttachmentKind } from "@/lib/attachmentTypes";

/** Extract supported attachment ``File``s from a paste / drop event.
 *
 * Deliberate behaviour:
 *   - Only items whose ``kind === "file"`` and extension is in the
 *     ``extract_documents`` whitelist are returned; ``<img>`` tags inside HTML
 *     fragments are ignored (defending against remote URL fetch + XSS surfaces).
 *   - Plain text pasted alongside files is *not* consumed by this helper,
 *     so the caller can still let the textarea receive it naturally.
 */
export function extractAttachmentFilesFromPaste(
  event: ClipboardEvent | React.ClipboardEvent,
): File[] {
  const clipboard = (event as ClipboardEvent).clipboardData
    ?? (event as React.ClipboardEvent).clipboardData;
  if (!clipboard) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file || !inferAttachmentKind(file)) continue;
    files.push(file);
  }
  return files;
}

/** Extract dropped attachment files, mirroring ``extractAttachmentFilesFromPaste``. */
export function extractAttachmentFilesFromDrop(
  event: DragEvent | React.DragEvent,
): File[] {
  const files: File[] = [];
  const list = event.dataTransfer?.files;
  if (!list) return files;
  for (const file of Array.from(list)) {
    if (inferAttachmentKind(file)) files.push(file);
  }
  return files;
}

/** @deprecated 使用 ``extractAttachmentFilesFromPaste``。 */
export function extractImageFilesFromPaste(
  event: ClipboardEvent | React.ClipboardEvent,
): File[] {
  return extractAttachmentFilesFromPaste(event);
}

/** @deprecated 使用 ``extractAttachmentFilesFromDrop``。 */
export function extractImageFilesFromDrop(
  event: DragEvent | React.DragEvent,
): File[] {
  return extractAttachmentFilesFromDrop(event);
}

export interface UseClipboardAndDropApi {
  isDragging: boolean;
  onPaste: (event: React.ClipboardEvent) => void;
  onDragEnter: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

/** Wire paste + drag-and-drop to a callback.
 *
 * The hook owns ``isDragging`` state and the refcount that keeps it accurate
 * across nested ``dragenter`` / ``dragleave`` events (a known DOM gotcha: the
 * text cursor inside a textarea fires ``dragleave`` on entry, flicking the
 * highlight off otherwise). */
export function useClipboardAndDrop(
  onFiles: (files: File[]) => void,
): UseClipboardAndDropApi {
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = extractAttachmentFilesFromPaste(event);
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    },
    [onFiles],
  );

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      dragDepth.current = 0;
      setIsDragging(false);
      const files = extractAttachmentFilesFromDrop(event);
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    },
    [onFiles],
  );

  return { isDragging, onPaste, onDragEnter, onDragOver, onDragLeave, onDrop };
}
