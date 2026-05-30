import { Inbox, Moon, Settings, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { channelInitial, channelLabel } from "@/lib/channels";
import { cn } from "@/lib/utils";

interface InboxSidebarProps {
  activeChannel: string | null;
  onSelectChannel: (channel: string | null) => void;
  /** Channels derived from message history (sourceChannel values). */
  channels?: string[];
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
}

export function InboxSidebar({
  activeChannel,
  onSelectChannel,
  channels = [],
  theme,
  onToggleTheme,
  onOpenSettings,
  settingsActive = false,
}: InboxSidebarProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={400}>
      <nav
        className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border/60 bg-sidebar py-2"
        aria-label={t("inbox.sidebarNav")}
      >
        {/* macOS hiddenInset 风格拖拽区域，顶部 28px 避让红绿灯按钮 */}
        <div
          className="h-7 w-full shrink-0"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />

        <NavItem
          label={t("inbox.unified")}
          active={activeChannel === null}
          onClick={() => onSelectChannel(null)}
        >
          <Inbox className="h-5 w-5" />
        </NavItem>

        {channels.length > 0 && (
          <>
            <Separator className="my-1 w-8" />
            {channels.map((ch) => (
              <NavItem
                key={ch}
                label={channelLabel(ch)}
                active={activeChannel === ch}
                onClick={() => onSelectChannel(ch)}
              >
                <span className="text-[11px] font-bold leading-none">
                  {channelInitial(ch)}
                </span>
              </NavItem>
            ))}
          </>
        )}

        <div className="flex-1" />

        <NavItem
          label={theme === "dark" ? t("inbox.themeDark") : t("inbox.themeLight")}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </NavItem>

        <NavItem
          label={t("inbox.settings")}
          active={settingsActive}
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
        </NavItem>
      </nav>
    </TooltipProvider>
  );
}

function NavItem({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-9 w-9 rounded-lg",
            active && "bg-sidebar-accent text-sidebar-accent-foreground",
            disabled && "cursor-not-allowed opacity-40",
          )}
          onClick={disabled ? undefined : onClick}
          aria-label={label}
          aria-current={active ? "page" : undefined}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
