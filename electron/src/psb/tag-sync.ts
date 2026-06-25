import type { UIMessage } from "../renderer/lib/types";
import { parsePsbTags } from "./psb-tags";

/** 当前回合内最后一条 user 消息之后的 assistant 正文（不含 trace）。 */
export function currentTurnAssistantMessages(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return [];
  let turnStart = messages.length - 1;
  while (turnStart >= 0 && messages[turnStart]?.role !== "user") {
    turnStart -= 1;
  }
  return messages
    .slice(turnStart + 1)
    .filter((message) => message.role === "assistant" && message.kind !== "trace");
}

/** 当前流式回合内所有 assistant 正文（不含 trace）。 */
export function collectStreamingAssistantText(
  messages: UIMessage[],
  isStreaming: boolean,
): string {
  if (!isStreaming || messages.length === 0) return "";
  return currentTurnAssistantMessages(messages)
    .map((message) => message.content)
    .join("\n");
}

/** 将消息中的 PSB 标签标记为已同步（不触发桌宠动作），用于历史回放。 */
export function markMessagesPsbTagsSynced(
  messages: UIMessage[],
  syncedCounts: Map<string, number>,
): void {
  for (const message of messages) {
    if (message.role !== "assistant" || message.kind === "trace") continue;
    syncedCounts.set(message.id, parsePsbTags(message.content).length);
  }
}

export async function sendPsbRuntimeAction(
  action: { type: string; payload?: Record<string, unknown> },
): Promise<boolean> {
  const api = window.electronAPI?.psb;
  if (!api?.sendAction) return false;
  const result = await api.sendAction(action);
  return result?.ok === true;
}

/** 将尚未发送的标签动作同步给 PSB 窗口；仅成功投递的动作会计入 emittedCount。 */
export async function syncNewPsbTags(text: string, emittedCount: number): Promise<number> {
  const actions = parsePsbTags(text);
  let delivered = emittedCount;
  for (let index = emittedCount; index < actions.length; index += 1) {
    const ok = await sendPsbRuntimeAction(actions[index]);
    if (!ok) break;
    delivered = index + 1;
  }
  return delivered;
}

/** 将给定 assistant 消息中的 PSB 标签同步给桌宠窗口。 */
export async function syncAllPsbTagsFromMessages(
  messages: UIMessage[],
  syncedCounts: Map<string, number>,
): Promise<void> {
  for (const message of messages) {
    const previous = syncedCounts.get(message.id) ?? 0;
    const next = await syncNewPsbTags(message.content, previous);
    syncedCounts.set(message.id, next);
  }
}
