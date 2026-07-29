import { Clock3, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { channelUiPresentation } from "@/channel-plugins/registry";
import type { UIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

export function MessageSourceBadge({
  message,
  inline = false,
}: {
  message: UIMessage;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const channel = message.sourceChannel?.trim().toLowerCase();
  const presentation = channel && channel !== "websocket"
    ? channelUiPresentation(channel)
    : undefined;
  const taskName = message.cronJobName?.trim();
  if (!presentation && !taskName && !message.channelDelivery) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground",
        !inline && "mb-1.5",
      )}
    >
      {presentation ? (
        <span
          className="inline-flex items-center gap-1 rounded-full border px-2 py-1 leading-none"
          style={{
            borderColor: `${presentation.color}33`,
            backgroundColor: `${presentation.color}18`,
            color: presentation.color,
          }}
        >
          {presentation.logoUrl ? (
            <img src={presentation.logoUrl} alt="" className="h-3 w-3 rounded-sm object-contain" />
          ) : (
            <MessageCircle className="h-3 w-3" aria-hidden />
          )}
          {presentation.displayName}
        </span>
      ) : null}
      {taskName || message.channelDelivery ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-2 py-1 leading-none">
          <Clock3 className="h-3 w-3" aria-hidden />
          {taskName?.toLowerCase() === "heartbeat"
            ? t("message.sourceHeartbeat", { defaultValue: "Heartbeat" })
            : taskName || t("message.sourceProactive", { defaultValue: "Proactive delivery" })}
        </span>
      ) : null}
    </div>
  );
}
