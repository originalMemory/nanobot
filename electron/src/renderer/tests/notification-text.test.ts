import { describe, expect, it } from 'vitest';

import {
  appendNotificationPreview,
  notificationBody,
  NOTIFICATION_BODY_BYTE_LIMIT,
  NOTIFICATION_IPC_TEXT_LIMIT,
} from '../../notification-text';

describe('notification text', () => {
  it('renderer 只保留有限长度的 IPC 摘要', () => {
    const preview = appendNotificationPreview('abc', 'x'.repeat(2000));

    expect(preview).toHaveLength(NOTIFICATION_IPC_TEXT_LIMIT);
    expect(preview.startsWith('abc')).toBe(true);
  });

  it('清理常见 Markdown 并保留可读文字', () => {
    expect(notificationBody({
      kind: 'assistant',
      text: '**完成**：查看 [报告](https://example.com) `report_file.md`',
    }, 'zh-CN')).toBe('完成：查看 报告 report_file.md');
  });

  it('兜底文案跟随语言', () => {
    expect(notificationBody({ kind: 'assistant' }, 'zh-CN')).toBe('AI 回复已完成');
    expect(notificationBody({ kind: 'assistant' }, 'en')).toBe('AI response completed');
    expect(notificationBody({ kind: 'user', hasMedia: true }, 'en')).toBe(
      'New media message',
    );
  });

  it('中文通知正文不超过 macOS 字节上限', () => {
    const body = notificationBody({
      kind: 'assistant',
      text: '焰'.repeat(160),
    }, 'zh-CN');

    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(
      NOTIFICATION_BODY_BYTE_LIMIT,
    );
    expect(body.endsWith('...')).toBe(true);
  });
});
