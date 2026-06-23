import { useCallback, useEffect, useRef } from "react";

import type { SettingsPayload, UIMessage } from "@/lib/types";

import { sendPsbRuntimeAction, syncNewPsbTags } from "../../psb/tag-sync";

/**
 * 监听 assistant 回复，解析 PSB 标签并转发给桌宠窗口；
 * 通过 ref 向 useNanobotStream 注册 turn_end 回调以触发状态恢复。
 */
export function usePsbTagEffects(
  messages: UIMessage[],
  settings: SettingsPayload | null | undefined,
  turnEndRef: React.MutableRefObject<() => void>,
): void {
  const enabled = settings?.deskPet?.psb?.enabledResponseTags === true;
  const syncedCountsRef = useRef(new Map<string, number>());

  turnEndRef.current = useCallback(() => {
    if (!enabled) return;
    sendPsbRuntimeAction({ type: "stream-end" });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    for (const message of messages) {
      if (message.role !== "assistant" || message.kind === "trace") continue;
      const previous = syncedCountsRef.current.get(message.id) ?? 0;
      const next = syncNewPsbTags(message.content, previous);
      syncedCountsRef.current.set(message.id, next);
    }
  }, [enabled, messages]);
}
