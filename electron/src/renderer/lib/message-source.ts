import { channelLabel, isHiddenLocalSourceChannel } from "@/lib/channels";
import type { UIMessage } from "@/lib/types";

export type MessageSourceBadgePart =
  | { kind: "channel"; channel: string; label: string }
  | { kind: "proactive"; label: string };

export type MessageSourceBadgeInfo = {
  parts: MessageSourceBadgePart[];
};

type SourceLabels = {
  proactive: string;
};

/** 解析 assistant 消息的来源徽章；无来源信息时返回 null。 */
export function resolveMessageSourceBadge(
  message: Pick<UIMessage, "sourceChannel" | "channelDelivery">,
  labels: SourceLabels,
): MessageSourceBadgeInfo | null {
  const parts: MessageSourceBadgePart[] = [];
  const channel = message.sourceChannel?.trim().toLowerCase();

  if (channel && !isHiddenLocalSourceChannel(channel)) {
    parts.push({
      kind: "channel",
      channel,
      label: channelLabel(channel),
    });
  }

  if (message.channelDelivery) {
    parts.push({ kind: "proactive", label: labels.proactive });
  }

  return parts.length > 0 ? { parts } : null;
}

/** 从 assistant turn 的多个 segment 中取首个含来源字段的 message。 */
export function pickMessageSourceFields(
  messages: Array<Pick<UIMessage, "sourceChannel" | "channelDelivery">>,
): Pick<UIMessage, "sourceChannel" | "channelDelivery"> | undefined {
  for (const message of messages) {
    if (
      (message.sourceChannel && !isHiddenLocalSourceChannel(message.sourceChannel))
      || message.channelDelivery
    ) {
      return message;
    }
  }
  return messages[0];
}
