import { useMemo, useState, type ReactNode } from "react";
import { Bell, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { channelAccentColor, channelLogoUrls } from "@/lib/channel-brand";
import { resolveMessageSourceBadge, type MessageSourceBadgePart } from "@/lib/message-source";
import { cn } from "@/lib/utils";

interface MessageSourceBadgeProps {
  message: import("@/lib/message-source").MessageSourceFields;
}

const BADGE_PILL_CLASS =
  "inline-flex h-[18px] items-center gap-1 rounded-full border px-1.5 text-[11px] [line-height:1]";

/** 固定 12×12 槽位，避免 favicon 透明边距导致视觉偏移。 */
function BadgeIconSlot({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-3 w-3 shrink-0 place-items-center [&_img]:h-full [&_img]:w-full [&_img]:object-contain [&_svg]:h-full [&_svg]:w-full">
      {children}
    </span>
  );
}

/** 中文字形视觉中心偏下，相对图标槽轻微上移。 */
function BadgeLabel({ children }: { children: ReactNode }) {
  return (
    <span className="relative -top-px whitespace-nowrap [line-height:1]">
      {children}
    </span>
  );
}

function ChannelSourceIcon({ channel }: { channel: string }) {
  const logoUrls = channelLogoUrls(channel);
  const [logoIndex, setLogoIndex] = useState(0);
  const logoUrl = logoUrls[logoIndex];

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        aria-hidden
        className="block rounded-sm"
        onError={() => setLogoIndex((index) => index + 1)}
      />
    );
  }

  return <MessageCircle className="block opacity-80" aria-hidden />;
}

function SourceBadgePart({ part }: { part: MessageSourceBadgePart }) {
  if (part.kind === "proactive") {
    return (
      <span
        className={cn(
          BADGE_PILL_CLASS,
          "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
        )}
      >
        <BadgeIconSlot>
          <Bell className="block text-amber-600 dark:text-amber-400" aria-hidden />
        </BadgeIconSlot>
        <BadgeLabel>{part.label}</BadgeLabel>
      </span>
    );
  }

  if (part.kind === "cron_job") {
    return (
      <span
        className={cn(
          BADGE_PILL_CLASS,
          "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
        )}
      >
        <BadgeLabel>{part.label}</BadgeLabel>
      </span>
    );
  }

  const accent = channelAccentColor(part.channel);
  return (
    <span
      className={cn(
        BADGE_PILL_CLASS,
        !accent && "border-border/60 bg-muted/40 text-muted-foreground/80",
      )}
      style={
        accent
          ? {
              color: accent,
              backgroundColor: `${accent}18`,
              borderColor: `${accent}33`,
            }
          : undefined
      }
    >
      <BadgeIconSlot>
        <ChannelSourceIcon channel={part.channel} />
      </BadgeIconSlot>
      <BadgeLabel>{part.label}</BadgeLabel>
    </span>
  );
}

/** assistant 名称行右侧：图标 + 来源文字。 */
export function MessageSourceBadge({ message }: MessageSourceBadgeProps) {
  const { t } = useTranslation();
  const badge = useMemo(
    () =>
      resolveMessageSourceBadge(message, {
        proactive: t("message.source.proactive"),
        heartbeat: t("message.source.heartbeat"),
      }),
    [message, t],
  );

  if (!badge) return null;

  return (
    <span className="inline-flex items-center gap-1 [line-height:1]">
      {badge.parts.map((part, index) => (
        <SourceBadgePart key={`${part.kind}-${part.label}-${index}`} part={part} />
      ))}
    </span>
  );
}
