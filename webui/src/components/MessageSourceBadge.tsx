import { Bell, HeartPulse, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { channelUiPresentation } from "@/channel-plugins/registry";
import type { UIMessage } from "@/lib/types";

const PILL = "inline-flex h-[18px] items-center gap-1 rounded-full border px-1.5 text-[11px] [line-height:1]";

export function MessageSourceBadge({ source }: { source?: UIMessage["source"] }) {
  const { t } = useTranslation();
  if (!source?.kind) return null;
  if (source.kind === "channel") {
    const channel = source.label?.trim() || "channel";
    const presentation = channelUiPresentation(channel);
    const Icon = presentation?.icon;
    const color = presentation?.color;
    return <span data-message-source="channel" className={`${PILL} ${color ? "" : "border-border/60 bg-muted/40 text-muted-foreground/80"}`}
      style={color ? { color, backgroundColor: `${color}18`, borderColor: `${color}33` } : undefined}>
      <span className="grid h-3 w-3 shrink-0 place-items-center">
        {presentation?.logoUrl ? <img src={presentation.logoUrl} alt="" className="h-3 w-3 rounded-sm object-contain" />
          : Icon ? <Icon className="h-3 w-3" /> : <MessageCircle className="h-3 w-3 opacity-80" />}
      </span>
      <span className="relative -top-px whitespace-nowrap">{presentation?.displayName ?? channel}</span>
    </span>;
  }
  const heartbeat = source.kind === "heartbeat";
  const cron = source.kind === "cron";
  const label = source.label?.trim() || (heartbeat
    ? t("message.heartbeatSource", { defaultValue: "Heartbeat" })
    : t("message.automationSourceFallback"));
  return <span data-message-source={source.kind} className={`${PILL} ${cron
    ? "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300"
    : "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"}`}>
    {heartbeat ? <HeartPulse className="h-3 w-3" aria-hidden />
      : !cron ? <Bell className="h-3 w-3" aria-hidden /> : null}
    <span className="relative -top-px whitespace-nowrap">{label}</span>
  </span>;
}
