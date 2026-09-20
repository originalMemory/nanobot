const NOTIFICATION_BODY_BYTE_LIMIT = 240;

function stripMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`|\*\*|~~/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateUtf8(text, limit = NOTIFICATION_BODY_BYTE_LIMIT) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const suffix = '...';
  let result = '';
  for (const char of text) {
    if (Buffer.byteLength(result + char + suffix, 'utf8') > limit) break;
    result += char;
  }
  return result + suffix;
}

function notificationBody(payload = {}, locale = 'zh-CN') {
  const text = typeof payload.text === 'string' ? stripMarkdown(payload.text) : '';
  if (text) return truncateUtf8(text);
  const chinese = locale.toLowerCase().startsWith('zh');
  if (payload.hasMedia === true) return chinese ? '收到一条媒体消息' : 'New media message';
  return chinese ? 'AI 回复已完成' : 'AI response completed';
}

module.exports = { NOTIFICATION_BODY_BYTE_LIMIT, notificationBody };
