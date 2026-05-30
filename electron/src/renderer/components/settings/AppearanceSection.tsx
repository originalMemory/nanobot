import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
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
  theme: "light" | "dark";
  onToggleTheme: () => void;
  localPrefs: LocalPreferences;
  onLocalPrefsChange: (prefs: LocalPreferences) => void;
}

export function AppearanceSection({
  theme,
  onToggleTheme,
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
            <SegmentedControl
              value={theme}
              options={[
                { value: "light", label: t("settings.values.light") },
                { value: "dark", label: t("settings.values.dark") },
              ]}
              onChange={(value) => {
                if ((value === "light" || value === "dark") && value !== theme) {
                  onToggleTheme();
                }
              }}
            />
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
