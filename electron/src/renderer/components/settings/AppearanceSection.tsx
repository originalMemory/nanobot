import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ALL_THEMES, type Theme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import {
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  ToggleButton,
  type LocalActivityMode,
  type LocalDensity,
  type LocalPreferences,
} from "./shared";

interface AppearanceSectionProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  localPrefs: LocalPreferences;
  onLocalPrefsChange: (prefs: LocalPreferences) => void;
}

// 预览色取自 globals.css 中各 [data-theme] 块的 HSL → hex 转换，修改主题色时需同步更新
const THEME_COLORS: Record<Theme, { bg: string; primary: string; fg: string }> = {
  light:       { bg: "#fdfdfc", primary: "#2a7a8c", fg: "#2c2c2a" },
  dark:        { bg: "#2c2c2e", primary: "#d97706", fg: "#d1d1d6" },
  midnight:    { bg: "#0f172a", primary: "#ee7e00", fg: "#e2e8f0" },
  desert:      { bg: "#f9f2e7", primary: "#d98236", fg: "#5c3d2e" },
  neon:        { bg: "#1a0933", primary: "#ff2d95", fg: "#f0f0ff" },
  marshmallow: { bg: "#e6f7ff", primary: "#f5a5c3", fg: "#2e2a36" },
  ink:         { bg: "#f5f7fa", primary: "#2c3e50", fg: "#2c3e50" },
  party:       { bg: "#fffbf0", primary: "#ed7d00", fg: "#374151" },
  rainbow:     { bg: "#f8f9fe", primary: "#845ec2", fg: "#43436a" },
};

export function AppearanceSection({
  theme,
  onThemeChange,
  localPrefs,
  onLocalPrefsChange,
}: AppearanceSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const updatePref = <K extends keyof LocalPreferences>(key: K, value: LocalPreferences[K]) => {
    onLocalPrefsChange({ ...localPrefs, [key]: value });
  };

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{t("settings.sections.interface")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.rows.theme")}
            description={t("settings.help.theme")}
          >
            <div className="grid grid-cols-3 gap-2 w-full">
              {ALL_THEMES.map((name) => (
                <ThemeCard
                  key={name}
                  themeName={name}
                  label={t(`settings.values.${name}`)}
                  selected={theme === name}
                  onClick={() => onThemeChange(name)}
                />
              ))}
            </div>
          </SettingsRow>

          <SettingsRow
            title={t("settings.rows.language")}
            description={t("settings.help.language")}
          >
            <LanguageSwitcher />
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>
          {tx("settings.sections.localPreferences", "Local preferences")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.density", "Density")}
            description={tx("settings.help.density", "Stored in this device's settings.")}
          >
            <SegmentedControl
              value={localPrefs.density}
              options={[
                { value: "comfortable", label: tx("settings.values.comfortable", "Comfortable") },
                { value: "compact", label: tx("settings.values.compact", "Compact") },
              ]}
              onChange={(density) => updatePref("density", density as LocalDensity)}
            />
          </SettingsRow>

          <SettingsRow
            title={tx("settings.rows.activityMode", "Activity detail")}
            description={tx(
              "settings.help.activityMode",
              "Choose how much agent activity chrome to show by default.",
            )}
          >
            <SegmentedControl
              value={localPrefs.activityMode}
              options={[
                { value: "auto", label: tx("settings.values.auto", "Auto") },
                { value: "expanded", label: tx("settings.values.expanded", "Expanded") },
              ]}
              onChange={(activityMode) => updatePref("activityMode", activityMode as LocalActivityMode)}
            />
          </SettingsRow>

          <SettingsRow
            title={tx("settings.rows.codeWrap", "Code wrapping")}
            description={tx(
              "settings.help.codeWrap",
              "Keep long code lines readable on smaller screens.",
            )}
          >
            <ToggleButton
              checked={localPrefs.codeWrap}
              onChange={(codeWrap) => updatePref("codeWrap", codeWrap)}
              ariaLabel={tx("settings.rows.codeWrap", "Code wrapping")}
              label={localPrefs.codeWrap ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>

          <SettingsRow
            title={tx("settings.rows.brandLogos", "Brand logos")}
            description={tx(
              "settings.help.brandLogos",
              "Show third-party provider and CLI logos in Settings.",
            )}
          >
            <ToggleButton
              checked={localPrefs.brandLogos}
              onChange={(brandLogos) => updatePref("brandLogos", brandLogos)}
              ariaLabel={tx("settings.rows.brandLogos", "Brand logos")}
              label={localPrefs.brandLogos ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}

function ThemeCard({
  themeName,
  label,
  selected,
  onClick,
}: {
  themeName: Theme;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  const colors = THEME_COLORS[themeName];
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex flex-col items-start gap-1.5 rounded-lg border p-2.5 text-left transition-all hover:scale-[1.02]",
        selected
          ? "border-primary ring-1 ring-primary shadow-sm"
          : "border-border hover:border-primary/50",
      )}
      aria-pressed={selected}
    >
      <div
        className="flex h-8 w-full overflow-hidden rounded-md"
        style={{ background: colors.bg }}
      >
        <div className="flex-1" style={{ background: colors.bg }} />
        <div className="w-4" style={{ background: colors.primary }} />
        <div className="w-2" style={{ background: colors.fg, opacity: 0.5 }} />
      </div>

      <span className="text-[11px] leading-tight text-foreground/70 line-clamp-1">
        {label}
      </span>

      {selected && (
        <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary">
          <Check className="h-2.5 w-2.5 text-primary-foreground" />
        </span>
      )}
    </button>
  );
}
