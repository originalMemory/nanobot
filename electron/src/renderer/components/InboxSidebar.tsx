import { Check, FolderOpen, Inbox, Palette, Power, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ALL_THEMES, type Theme } from "@/hooks/useTheme";
import { channelInitial, channelLabel } from "@/lib/channels";
import { isElectron } from "@/lib/env";
import { cn } from "@/lib/utils";

const THEME_PREVIEW_COLORS: Record<Theme, string> = {
  light:       "#2a7a8c",
  dark:        "#d97706",
  midnight:    "#ee7e00",
  desert:      "#d98236",
  neon:        "#ff2d95",
  marshmallow: "#f5a5c3",
  ink:         "#2c3e50",
  party:       "#ed7d00",
  rainbow:     "#845ec2",
};

interface InboxSidebarProps {
  activeChannel: string | null;
  onSelectChannel: (channel: string | null) => void;
  /** Channels derived from message history (sourceChannel values). */
  channels?: string[];
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onOpenSettings?: () => void;
  onOpenWorkspace?: () => void;
  settingsActive?: boolean;
  workspaceActive?: boolean;
}

export function InboxSidebar({
  activeChannel,
  onSelectChannel,
  channels = [],
  theme,
  onThemeChange,
  onOpenSettings,
  onOpenWorkspace,
  settingsActive = false,
  workspaceActive = false,
}: InboxSidebarProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={400}>
      <nav
        className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border/60 bg-sidebar py-2"
        aria-label={t("inbox.sidebarNav")}
      >
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

        {onOpenWorkspace ? (
          <NavItem
            label={t("workspace.title")}
            active={workspaceActive}
            onClick={onOpenWorkspace}
          >
            <FolderOpen className="h-4 w-4" />
          </NavItem>
        ) : null}

        <ThemeDropdown
          theme={theme}
          onThemeChange={onThemeChange}
          t={t}
        />

        <NavItem
          label={t("inbox.settings")}
          active={settingsActive}
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
        </NavItem>

        {isElectron ? (
          <NavItem
            label={t("inbox.quit")}
            onClick={() => {
              void window.electronAPI.app.quit();
            }}
          >
            <Power className="h-4 w-4" />
          </NavItem>
        ) : null}
      </nav>
    </TooltipProvider>
  );
}

function ThemeDropdown({
  theme,
  onThemeChange,
  t,
}: {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-lg"
              aria-label={t("inbox.themeNext", "Choose theme")}
            >
              <Palette className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          {t("inbox.themeNext", "Choose theme")}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent side="right" align="end" className="min-w-[10rem]">
        {ALL_THEMES.map((name) => (
          <DropdownMenuItem
            key={name}
            onClick={() => onThemeChange(name)}
            className="flex items-center gap-2"
          >
            <span
              className="inline-block h-3 w-3 rounded-full border border-border/50 shrink-0"
              style={{ background: THEME_PREVIEW_COLORS[name] }}
            />
            <span className="flex-1">{t(`settings.values.${name}`)}</span>
            {theme === name && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
