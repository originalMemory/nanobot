import { useCallback, useEffect, useRef } from "react";

import type { SettingsPayload, UIMessage } from "@/lib/types";

import {
  currentTurnAssistantMessages,
  markMessagesPsbTagsSynced,
  sendPsbRuntimeAction,
  syncAllPsbTagsFromMessages,
} from "../../psb/tag-sync";

/**
 * 监听 assistant 直播回复，解析 PSB 标签并转发给桌宠窗口；
 * 历史消息加载/刷新不会触发动作。通过 ref 向 useNanobotStream 注册 turn_end 回调。
 */
export function usePsbTagEffects(
  messages: UIMessage[],
  settings: SettingsPayload | null | undefined,
  turnEndRef: React.MutableRefObject<() => void>,
  skipHistoryRef: React.MutableRefObject<() => void>,
  isStreaming: boolean,
): void {
  const enabled = settings?.deskPet?.psb?.enabledResponseTags === true;
  const syncedCountsRef = useRef(new Map<string, number>());
  const messagesRef = useRef(messages);
  const syncTailRef = useRef(Promise.resolve());
  const initialHistoryMarkedRef = useRef(false);

  messagesRef.current = messages;

  if (!initialHistoryMarkedRef.current) {
    initialHistoryMarkedRef.current = true;
    markMessagesPsbTagsSynced(messages, syncedCountsRef.current);
  }

  const enqueuePsbSync = useCallback((job: () => Promise<void>) => {
    syncTailRef.current = syncTailRef.current
      .catch((): undefined => undefined)
      .then((): Promise<void> => job());
  }, []);

  skipHistoryRef.current = useCallback(() => {
    markMessagesPsbTagsSynced(messagesRef.current, syncedCountsRef.current);
  }, []);

  turnEndRef.current = useCallback(() => {
    if (!enabled) return;
    enqueuePsbSync(async () => {
      const turnMessages = currentTurnAssistantMessages(messagesRef.current);
      await syncAllPsbTagsFromMessages(turnMessages, syncedCountsRef.current);
      await sendPsbRuntimeAction({ type: "stream-end" });
    });
  }, [enabled, enqueuePsbSync]);

  useEffect(() => {
    if (!enabled || !isStreaming) return;
    enqueuePsbSync(async () => {
      const turnMessages = currentTurnAssistantMessages(messagesRef.current);
      await syncAllPsbTagsFromMessages(turnMessages, syncedCountsRef.current);
    });
  }, [enabled, enqueuePsbSync, isStreaming, messages]);
}
