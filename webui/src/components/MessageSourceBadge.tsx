import { Bell, MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { channelUiPresentation } from "@/channel-plugins/registry";
import type { UIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

const BADGE_PILL_CLASS =
  "inline-flex h-[18px] items-center gap-1 rounded-full border px-1.5 text-[11px] [line-height:1]";

function BadgeIconSlot({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-3 w-3 shrink-0 place-items-center [&_img]:h-full [&_img]:w-full [&_img]:object-contain [&_svg]:h-full [&_svg]:w-full">
      {children}
    </span>
  );
}

function BadgeLabel({ children }: { children: ReactNode }) {
  return (
    <span className="relative -top-px whitespace-nowrap [line-height:1]">
      {children}
    </span>
  );
}

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
          className={BADGE_PILL_CLASS}
          style={{
            borderColor: `${presentation.color}33`,
            backgroundColor: `${presentation.color}18`,
            color: presentation.color,
          }}
        >
          <BadgeIconSlot>
            {presentation.logoUrl ? (
              <img src={presentation.logoUrl} alt="" className="block rounded-sm" />
            ) : (
              <MessageCircle className="block opacity-80" aria-hidden />
            )}
          </BadgeIconSlot>
          <BadgeLabel>{presentation.displayName}</BadgeLabel>
        </span>
      ) : null}
      {taskName ? (
        <span className={cn(BADGE_PILL_CLASS, "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300")}>
          <BadgeLabel>
            {taskName.toLowerCase() === "heartbeat"
              ? t("message.source.heartbeat")
              : taskName}
          </BadgeLabel>
        </span>
      ) : message.channelDelivery ? (
        <span className={cn(BADGE_PILL_CLASS, "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300")}>
          <BadgeIconSlot>
            <Bell className="block text-amber-600 dark:text-amber-400" aria-hidden />
          </BadgeIconSlot>
          <BadgeLabel>{t("message.source.proactive")}</BadgeLabel>
        </span>
      ) : null}
    </div>
  );
}
