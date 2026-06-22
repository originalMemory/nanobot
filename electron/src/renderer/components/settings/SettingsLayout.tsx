import { Activity, Blocks, ChevronLeft, Globe2, ImageIcon, Palette, Server, ShieldCheck, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SettingsSectionKey } from "./shared";

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

const SETTINGS_NAV_ITEMS: Array<{
  key: SettingsSectionKey;
  icon: LucideIcon;
  fallback: string;
}> = [
  { key: "overview", icon: Activity, fallback: "Overview" },
  { key: "appearance", icon: Palette, fallback: "Appearance" },
  { key: "models", icon: SlidersHorizontal, fallback: "Models" },
  { key: "image", icon: ImageIcon, fallback: "Image" },
  { key: "tha", icon: Sparkles, fallback: "THA" },
  { key: "web", icon: Globe2, fallback: "Web" },
  { key: "apps", icon: Blocks, fallback: "Apps" },
  { key: "runtime", icon: Server, fallback: "Runtime" },
  { key: "advanced", icon: ShieldCheck, fallback: "Advanced" },
];

function titleForSection(section: SettingsSectionKey): string {
  return SETTINGS_NAV_ITEMS.find((item) => item.key === section)?.fallback ?? "Settings";
}

// ---------------------------------------------------------------------------
// SettingsLayout
// ---------------------------------------------------------------------------

interface SettingsLayoutProps {
  activeSection: SettingsSectionKey;
  onSelectSection: (section: SettingsSectionKey) => void;
  onBack: () => void;
  children: React.ReactNode;
  loading?: boolean;
  error?: string | null;
}

export function SettingsLayout({
  activeSection,
  onSelectSection,
  onBack,
  children,
  loading = false,
  error = null,
}: SettingsLayoutProps) {
  const { t } = useTranslation();

  return (
    <div className="settings-layout-root flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      {/* Sidebar nav */}
      <aside className="flex w-full shrink-0 flex-col border-b border-border/55 bg-card/62 px-4 pb-3 pt-4 shadow-[inset_0_-1px_0_rgba(255,255,255,0.55)] backdrop-blur-xl dark:bg-card/45 dark:shadow-none md:w-[17rem] md:border-b-0 md:border-r md:px-3 md:py-4 md:shadow-[inset_-1px_0_0_rgba(255,255,255,0.55)]">
        <button
          type="button"
          onClick={onBack}
          className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground md:mb-3"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          {t("settings.backToChat")}
        </button>

        <div className="mb-3 px-1 md:mb-4 md:px-2">
          <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-foreground">
            {t("settings.sidebar.title")}
          </h2>
        </div>

        <nav
          aria-label={t("settings.sidebar.ariaLabel")}
          className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:block md:space-y-1 md:overflow-visible md:px-0 md:pb-0"
        >
          {SETTINGS_NAV_ITEMS.map(({ key, icon: Icon, fallback }) => {
            const active = key === activeSection;
            return (
              <button
                key={key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onSelectSection(key)}
                className={cn(
                  "flex h-9 w-auto shrink-0 items-center gap-2 rounded-full px-3 text-left text-[13px] font-medium transition-colors md:w-full md:rounded-[10px] md:px-2.5",
                  active
                    ? "bg-muted/90 text-foreground shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
                    : "text-muted-foreground/78 hover:bg-muted/45 hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
                <span className="truncate">
                  {t(`settings.nav.${key}`, { defaultValue: fallback })}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 lg:py-12">
          <div className="mb-7">
            <p className="mb-2 text-[13px] font-medium text-muted-foreground">
              {t("settings.sidebar.title")}
            </p>
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[34px]">
              {t(`settings.nav.${activeSection}`, { defaultValue: titleForSection(activeSection) })}
            </h1>
          </div>

          {loading ? (
            <div className="flex h-48 items-center justify-center rounded-[24px] border border-border/50 bg-card/75 text-sm text-muted-foreground shadow-[0_20px_70px_rgba(15,23,42,0.07)]">
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t("settings.status.loading")}
            </div>
          ) : error ? (
            <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
              <div className="divide-y divide-border/45">
                <div className="flex min-h-[62px] flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium leading-5 text-foreground">
                      {t("settings.status.loadError")}
                    </div>
                  </div>
                  <span className="max-w-[520px] text-sm text-muted-foreground">{error}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-5">{children}</div>
          )}
        </div>
      </main>
    </div>
  );
}
