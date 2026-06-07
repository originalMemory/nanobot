import { describe, expect, it, vi } from 'vitest';

import {
  getInboundSourceChannel,
  isTrayNotifyInboundEvent,
  matchesTrayNotifyChannel,
  requestTrayBlinkForInboxEvent,
  requestTrayBlinkForStreamTurnEnd,
} from '@/lib/tray-notify';
import type { InboundEvent } from '@/lib/types';

describe('matchesTrayNotifyChannel', () => {
  it('activeChannel 为 null 时全部通过', () => {
    expect(matchesTrayNotifyChannel(null, undefined)).toBe(true);
    expect(matchesTrayNotifyChannel(null, 'telegram')).toBe(true);
  });

  it('过滤频道时要求 source_channel 精确匹配', () => {
    expect(matchesTrayNotifyChannel('telegram', 'telegram')).toBe(true);
    expect(matchesTrayNotifyChannel('telegram', 'discord')).toBe(false);
    expect(matchesTrayNotifyChannel('telegram', undefined)).toBe(false);
  });
});

describe('isTrayNotifyInboundEvent', () => {
  it('外部 channel user 入站应触发', () => {
    const ev: InboundEvent = {
      event: 'user',
      chat_id: 'inbox:unified',
      text: 'hi',
      source_channel: 'telegram',
    };
    expect(isTrayNotifyInboundEvent(ev)).toBe(true);
  });

  it('无 source_channel 的 user 不触发', () => {
    const ev: InboundEvent = {
      event: 'user',
      chat_id: 'inbox:unified',
      text: 'hi',
    };
    expect(isTrayNotifyInboundEvent(ev)).toBe(false);
  });

  it('完整 assistant message 应触发', () => {
    const ev: InboundEvent = {
      event: 'message',
      chat_id: 'inbox:unified',
      text: 'reply',
      channel_delivery: true,
    };
    expect(isTrayNotifyInboundEvent(ev)).toBe(true);
  });

  it('空文本且无媒体的 message 不触发', () => {
    const ev: InboundEvent = {
      event: 'message',
      chat_id: 'inbox:unified',
      text: '   ',
    };
    expect(isTrayNotifyInboundEvent(ev)).toBe(false);
  });

  it('tool_hint 中间帧不触发', () => {
    const ev: InboundEvent = {
      event: 'message',
      chat_id: 'inbox:unified',
      text: 'using tool',
      kind: 'tool_hint',
    };
    expect(isTrayNotifyInboundEvent(ev)).toBe(false);
  });

  it('delta 不触发', () => {
    const ev: InboundEvent = {
      event: 'delta',
      chat_id: 'inbox:unified',
      text: 'chunk',
    };
    expect(isTrayNotifyInboundEvent(ev)).toBe(false);
  });
});

describe('getInboundSourceChannel', () => {
  it('读取 source_channel 字段', () => {
    expect(getInboundSourceChannel({
      event: 'user',
      chat_id: 'inbox:unified',
      text: 'hi',
      source_channel: 'telegram',
    })).toBe('telegram');
  });
});

describe('requestTrayBlinkForInboxEvent', () => {
  it('inbox 符合条件时调用 electronAPI', () => {
    const notifyIncoming = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      electronAPI: { tray: { notifyIncoming } },
    });

    requestTrayBlinkForInboxEvent('inbox:unified', {
      event: 'user',
      chat_id: 'inbox:unified',
      text: 'hi',
      source_channel: 'telegram',
    });

    expect(notifyIncoming).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('非 inbox chatId 不调用', () => {
    const notifyIncoming = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: { tray: { notifyIncoming } },
    });

    requestTrayBlinkForInboxEvent('electron-main', {
      event: 'user',
      chat_id: 'electron-main',
      text: 'hi',
      source_channel: 'telegram',
    });

    expect(notifyIncoming).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('频道过滤不匹配时不调用', () => {
    const notifyIncoming = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: { tray: { notifyIncoming } },
    });

    requestTrayBlinkForInboxEvent(
      'inbox:unified',
      {
        event: 'user',
        chat_id: 'inbox:unified',
        text: 'hi',
        source_channel: 'discord',
      },
      { activeChannel: 'telegram' },
    );

    expect(notifyIncoming).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('requestTrayBlinkForStreamTurnEnd', () => {
  it('有 assistant delta 时调用 electronAPI', () => {
    const notifyIncoming = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      electronAPI: { tray: { notifyIncoming } },
    });

    requestTrayBlinkForStreamTurnEnd('inbox:unified', true, undefined);

    expect(notifyIncoming).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('无 assistant delta 不调用', () => {
    const notifyIncoming = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: { tray: { notifyIncoming } },
    });

    requestTrayBlinkForStreamTurnEnd('inbox:unified', false, undefined);

    expect(notifyIncoming).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('频道过滤不匹配时不调用', () => {
    const notifyIncoming = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: { tray: { notifyIncoming } },
    });

    requestTrayBlinkForStreamTurnEnd(
      'inbox:unified',
      true,
      'discord',
      { activeChannel: 'telegram' },
    );

    expect(notifyIncoming).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
