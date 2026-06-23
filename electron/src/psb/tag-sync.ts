import type { UIMessage } from "../renderer/lib/types";
import { parsePsbTags } from "./psb-tags";

/** 当前流式回合内所有 assistant 正文（不含 trace）。 */
export function collectStreamingAssistantText(
  messages: UIMessage[],
  isStreaming: boolean,
): string {
  if (!isStreaming || messages.length === 0) return "";
  let turnStart = messages.length - 1;
  while (turnStart >= 0 && messages[turnStart]?.role !== "user") {
    turnStart -= 1;
  }
  return messages
    .slice(turnStart + 1)
    .filter((message) => message.role === "assistant" && message.kind !== "trace")
    .map((message) => message.content)
    .join("\n");
}

export function sendPsbRuntimeAction(action: { type: string; payload?: Record<string, unknown> }): void {
  const api = window.electronAPI?.psb;
  if (!api?.sendAction) return;
  void api.sendAction(action);
}

/** 将尚未发送的标签动作同步给 PSB 窗口。 */
export function syncNewPsbTags(text: string, emittedCount: number): number {
  const actions = parsePsbTags(text);
  for (let index = emittedCount; index < actions.length; index += 1) {
    sendPsbRuntimeAction(actions[index]);
  }
  return actions.length;
}
