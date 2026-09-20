const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NOTIFICATION_BODY_BYTE_LIMIT, notificationBody } = require('../notification-text.cjs');

test('通知正文清理 Markdown 并使用回复文本', () => {
  assert.equal(notificationBody({ text: '**完成**：查看 [报告](https://example.com) `report.md`' }),
    '完成：查看 报告 report.md');
});

test('通知正文按 UTF-8 字节截断并提供媒体兜底', () => {
  const body = notificationBody({ text: '焰'.repeat(160) });
  assert.ok(Buffer.byteLength(body, 'utf8') <= NOTIFICATION_BODY_BYTE_LIMIT);
  assert.ok(body.endsWith('...'));
  assert.equal(notificationBody({ hasMedia: true }, 'zh-CN'), '收到一条媒体消息');
});
