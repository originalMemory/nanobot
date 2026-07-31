export const NOTIFICATION_IPC_TEXT_LIMIT = 1000;
export const NOTIFICATION_BODY_BYTE_LIMIT = 240;

export type NativeNotificationPayload = {
  kind: 'user' | 'assistant';
  text?: string;
  hasMedia?: boolean;
};

/** renderer 侧限制 IPC 文本；保留当前回复段开头，避免复制整轮长回复。 */
export function appendNotificationPreview(current: string, chunk: string): string {
  if (current.length >= NOTIFICATION_IPC_TEXT_LIMIT) return current;
  return (current + chunk).slice(0, NOTIFICATION_IPC_TEXT_LIMIT);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`|\*\*|~~/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateUtf8(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= limit) return text;

  const suffix = '...';
  const suffixBytes = encoder.encode(suffix).length;
  let usedBytes = 0;
  let truncated = '';
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (usedBytes + charBytes + suffixBytes > limit) break;
    truncated += char;
    usedBytes += charBytes;
  }
  return truncated + suffix;
}

/** main 进程生成最终系统通知正文。 */
export function notificationBody(
  payload: Partial<NativeNotificationPayload>,
  locale: string,
): string {
  const text = typeof payload.text === 'string' ? stripMarkdown(payload.text) : '';
  if (text) return truncateUtf8(text, NOTIFICATION_BODY_BYTE_LIMIT);

  const isChinese = locale.toLowerCase().startsWith('zh');
  if (payload.hasMedia === true) {
    return isChinese ? '收到一条媒体消息' : 'New media message';
  }
  if (payload.kind === 'assistant') {
    return isChinese ? 'AI 回复已完成' : 'AI response completed';
  }
  return isChinese ? '收到一条新消息' : 'New message';
}
