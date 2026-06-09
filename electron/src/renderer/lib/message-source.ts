import { channelLabel, isHiddenLocalSourceChannel } from "@/lib/channels";
import type { UIMessage } from "@/lib/types";

export type MessageSourceBadgePart =
  | { kind: "channel"; channel: string; label: string }
  | { kind: "proactive"; label: string }
  | { kind: "cron_job"; label: string };

export type MessageSourceBadgeInfo = {
  parts: MessageSourceBadgePart[];
};

type SourceLabels = {
  proactive: string;
  heartbeat: string;
};

export type MessageSourceFields = Pick<
  UIMessage,
  "sourceChannel" | "channelDelivery" | "userInitiatedDelivery" | "cronJobId" | "cronJobName"
>;

/**
 * 解析 assistant 消息的来源徽章；无来源信息时返回 null。
 * 展示规则：可见通道名 + 任务名；无任务名的旧 channelDelivery 数据兜底「主动推送」。
 */
export function resolveMessageSourceBadge(
  message: MessageSourceFields,
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

  const cronJobName = message.cronJobName?.trim();
  if (cronJobName) {
    const label = cronJobName.toLowerCase() === "heartbeat"
      ? labels.heartbeat
      : cronJobName;
    parts.push({ kind: "cron_job", label });
  } else if (message.channelDelivery) {
    parts.push({ kind: "proactive", label: labels.proactive });
  }

  return parts.length > 0 ? { parts } : null;
}

/** 从 assistant turn 的多个 segment 中取首个含来源字段的 message。 */
export function pickMessageSourceFields(
  messages: Array<MessageSourceFields>,
): MessageSourceFields | undefined {
  for (const message of messages) {
    if (
      (message.sourceChannel && !isHiddenLocalSourceChannel(message.sourceChannel))
      || message.channelDelivery
      || message.userInitiatedDelivery
      || message.cronJobName
    ) {
      return message;
    }
  }
  return messages[0];
}
