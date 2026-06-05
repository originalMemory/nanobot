/** 与后端 ``_VISION_CAPTION_SENTINEL`` 保持一致。 */
export const VISION_CAPTION_SENTINEL = "\n\u200b[vision-caption]\u200b\n";

export interface VisionCaptionPart {
  text: string;
  done: boolean;
  error?: string;
}

export function extractCaptionBlocks(content: string): {
  displayText: string;
  captionText: string | null;
} {
  const idx = content.indexOf(VISION_CAPTION_SENTINEL);
  if (idx === -1) return { displayText: content, captionText: null };
  return {
    displayText: content.slice(0, idx),
    captionText: content.slice(idx + VISION_CAPTION_SENTINEL.length) || null,
  };
}

/** 将流式/part 状态格式化为与后端 ``format_captions`` 一致的 caption 正文。 */
export function formatVisionCaptionSegments(
  parts: ReadonlyMap<number, VisionCaptionPart>,
  imageCount: number,
): string {
  if (imageCount <= 0) return "";
  const multi = imageCount > 1;
  const segments: string[] = [];
  for (let i = 0; i < imageCount; i += 1) {
    const part = parts.get(i);
    if (!part) continue;
    const n = i + 1;
    if (part.error && part.done) {
      const reason = `（描述获取失败 - ${part.error}）`;
      segments.push(multi ? `**图片 ${n}**\n${reason}` : `图片描述：${reason}`);
      continue;
    }
    if (!part.text && !part.done) continue;
    if (multi) {
      segments.push(`**图片 ${n}**\n${part.text}`);
    } else if (part.done) {
      segments.push(`图片描述：${part.text}`);
    } else {
      segments.push(part.text);
    }
  }
  return segments.join("\n\n");
}

export function userMessageImageCount(message: {
  images?: unknown[];
  media?: unknown[];
}): number {
  return message.images?.length ?? message.media?.length ?? 0;
}

export function applyVisionCaptionParts(
  content: string,
  parts: ReadonlyMap<number, VisionCaptionPart>,
  imageCount: number,
): string {
  const { displayText } = extractCaptionBlocks(content);
  const captionText = formatVisionCaptionSegments(parts, imageCount);
  if (!captionText) return displayText;
  return displayText + VISION_CAPTION_SENTINEL + captionText;
}

export function allVisionCaptionsDone(
  parts: ReadonlyMap<number, VisionCaptionPart>,
  imageCount: number,
): boolean {
  if (imageCount <= 0) return true;
  for (let i = 0; i < imageCount; i += 1) {
    const part = parts.get(i);
    if (!part?.done) return false;
  }
  return true;
}
