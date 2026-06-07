import type { InboundEvent } from '@/lib/types';

const INBOX_UNIFIED_CHAT_ID = 'inbox:unified';

export type TrayNotifyOptions = {
  /** null / undefined = 全部频道；string = 仅匹配该 source_channel */
  activeChannel?: string | null;
};

/** 从入站事件读取 source_channel（若存在）。 */
export function getInboundSourceChannel(ev: InboundEvent): string | undefined {
  if ('source_channel' in ev && typeof ev.source_channel === 'string' && ev.source_channel) {
    return ev.source_channel;
  }
  return undefined;
}

/** 当前 sidebar 频道过滤是否允许提醒。 */
export function matchesTrayNotifyChannel(
  activeChannel: string | null | undefined,
  sourceChannel: string | undefined,
): boolean {
  if (activeChannel == null) return true;
  if (!sourceChannel) return false;
  return sourceChannel === activeChannel;
}

/** 是否为应触发托盘提醒的 inbox 实时入站事件。 */
export function isTrayNotifyInboundEvent(ev: InboundEvent): boolean {
  if (ev.event === 'user') {
    return typeof ev.source_channel === 'string' && ev.source_channel.length > 0;
  }
  if (ev.event === 'message') {
    if (ev.kind === 'tool_hint' || ev.kind === 'progress' || ev.kind === 'reasoning') {
      return false;
    }
    const text = typeof ev.text === 'string' ? ev.text.trim() : '';
    const hasMedia = !!(ev.media_urls?.length || ev.media?.length);
    return text.length > 0 || hasMedia;
  }
  return false;
}

function invokeTrayNotify(): void {
  void window.electronAPI?.tray?.notifyIncoming?.();
}

/** 统一收件箱实时 WS 事件到达时请求主进程托盘闪烁。 */
export function requestTrayBlinkForInboxEvent(
  chatId: string | null,
  ev: InboundEvent,
  options?: TrayNotifyOptions,
): void {
  if (chatId !== INBOX_UNIFIED_CHAT_ID) return;
  if (!isTrayNotifyInboundEvent(ev)) return;
  if (!matchesTrayNotifyChannel(options?.activeChannel, getInboundSourceChannel(ev))) return;
  invokeTrayNotify();
}

/** 流式回合在 turn_end 完成且本轮有 assistant delta 时请求托盘闪烁。 */
export function requestTrayBlinkForStreamTurnEnd(
  chatId: string | null,
  hadAssistantDelta: boolean,
  sourceChannel: string | undefined,
  options?: TrayNotifyOptions,
): void {
  if (chatId !== INBOX_UNIFIED_CHAT_ID) return;
  if (!hadAssistantDelta) return;
  if (!matchesTrayNotifyChannel(options?.activeChannel, sourceChannel)) return;
  invokeTrayNotify();
}
