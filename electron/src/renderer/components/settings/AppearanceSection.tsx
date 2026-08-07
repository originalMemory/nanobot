import { formatForDisplay, useHotkeyRecorder, type Hotkey } from "@tanstack/react-hotkeys";
import { Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ALL_THEMES, type Theme } from "@/hooks/useTheme";
import { isElectron } from "@/lib/env";
import {
  electronAcceleratorToHotkey,
  hotkeyToElectronAccelerator,
} from "@/lib/hotkey-accelerator";
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

type OpenAtLoginState = {
  available: boolean;
  enabled: boolean;
  status: "not-registered" | "enabled" | "requires-approval" | "not-found" | null;
};

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

          {isElectron &&
          (window.electronAPI.platform.isMac || window.electronAPI.platform.isWindows) ? (
            <OpenAtLoginRow tx={tx} />
          ) : null}

          {isElectron ? <RaiseInboxShortcutRow tx={tx} /> : null}
        </SettingsGroup>
      </section>

      {isElectron ? (
        <section>
          <SettingsSectionTitle>
            {tx("settings.sections.wallpaper", "Wallpaper")}
          </SettingsSectionTitle>
          <SettingsGroup>
            <WallpaperSettingsRow tx={tx} />
          </SettingsGroup>
        </section>
      ) : null}
    </div>
  );
}

function OpenAtLoginRow({
  tx,
}: {
  tx: (key: string, fallback: string) => string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<OpenAtLoginState>({
    available: false,
    enabled: false,
    status: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.app.getOpenAtLogin()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setError(t("settings.errors.openAtLoginUpdateFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleChange = useCallback(async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setState(await window.electronAPI.app.setOpenAtLogin(enabled));
    } catch {
      setError(t("settings.errors.openAtLoginUpdateFailed"));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const label = !state.available && !loading
    ? t("settings.values.notAvailable")
    : state.enabled
      ? t("settings.values.on")
      : t("settings.values.off");

  return (
    <SettingsRow
      title={tx("settings.rows.openAtLogin", "Open at login")}
      description={tx(
        "settings.help.openAtLogin",
        "Automatically start Nanobot after you sign in. Available in the installed app.",
      )}
    >
      <div className="flex flex-col items-end gap-1.5">
        <ToggleButton
          checked={state.enabled}
          onChange={(enabled) => void handleChange(enabled)}
          disabled={loading || saving || !state.available}
          ariaLabel={tx("settings.rows.openAtLogin", "Open at login")}
          label={label}
        />
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {!error && state.status === "requires-approval" ? (
          <p className="max-w-72 text-right text-xs leading-5 text-amber-600 dark:text-amber-400">
            {t("settings.status.openAtLoginRequiresApproval")}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function WallpaperSettingsRow({
  tx,
}: {
  tx: (key: string, fallback: string) => string;
}) {
  const { t } = useTranslation();
  const [savedSource, setSavedSource] = useState<"url" | "directory">("url");
  const [savedUrl, setSavedUrl] = useState("");
  const [savedDirectory, setSavedDirectory] = useState("");
  const [savedOrder, setSavedOrder] = useState<"sequential" | "random">("sequential");
  const [savedIndex, setSavedIndex] = useState(-1);
  const [savedInterval, setSavedInterval] = useState(1);
  const [draftSource, setDraftSource] = useState<"url" | "directory">("url");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftDirectory, setDraftDirectory] = useState("");
  const [draftOrder, setDraftOrder] = useState<"sequential" | "random">("sequential");
  const [draftInterval, setDraftInterval] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.wallpaper.getConfig().then((config) => {
      setSavedSource(config.source);
      setSavedUrl(config.url);
      setSavedDirectory(config.directory);
      setSavedOrder(config.localOrder);
      setSavedIndex(config.localIndex);
      setSavedInterval(config.intervalMinutes);
      setDraftSource(config.source);
      setDraftUrl(config.url);
      setDraftDirectory(config.directory);
      setDraftOrder(config.localOrder);
      setDraftInterval(config.intervalMinutes);
    }).catch(() => { /* ignore load errors */ });
  }, []);

  const dirty =
    draftSource !== savedSource ||
    draftUrl.trim() !== savedUrl.trim() ||
    draftDirectory.trim() !== savedDirectory.trim() ||
    draftOrder !== savedOrder ||
    Math.max(1, Math.floor(draftInterval) || 1) !== savedInterval;

  const chooseDirectory = useCallback(async () => {
    try {
      const directory = await window.electronAPI.wallpaper.chooseDirectory();
      if (directory) {
        setDraftDirectory(directory);
        setError(null);
      }
    } catch {
      setError(t("settings.errors.wallpaperSaveFailed"));
    }
  }, [t]);

  const handleSave = useCallback(async () => {
    const intervalMinutes = Math.max(1, Math.floor(draftInterval) || 1);
    setSaving(true);
    setError(null);
    try {
      const next = await window.electronAPI.wallpaper.setConfig({
        source: draftSource,
        url: draftUrl.trim(),
        directory: draftDirectory.trim(),
        localOrder: draftOrder,
        localIndex: savedIndex,
        intervalMinutes,
      });
      setSavedSource(next.source);
      setSavedUrl(next.url);
      setSavedDirectory(next.directory);
      setSavedOrder(next.localOrder);
      setSavedIndex(next.localIndex);
      setSavedInterval(next.intervalMinutes);
      setDraftSource(next.source);
      setDraftUrl(next.url);
      setDraftDirectory(next.directory);
      setDraftOrder(next.localOrder);
      setDraftInterval(next.intervalMinutes);
    } catch {
      setError(t("settings.errors.wallpaperSaveFailed"));
    } finally {
      setSaving(false);
    }
  }, [draftDirectory, draftInterval, draftOrder, draftSource, draftUrl, savedIndex, t]);

  return (
    <SettingsRow
      title={tx("settings.rows.wallpaper", "Dynamic wallpaper")}
      description={tx(
        "settings.help.wallpaper",
        "Rotate a network image or images from a local directory while the window is visible.",
      )}
    >
      <div className="flex w-full flex-col gap-2">
        <SegmentedControl
          value={draftSource}
          options={[
            { value: "url", label: tx("settings.values.wallpaperUrlSource", "Network URL") },
            { value: "directory", label: tx("settings.values.wallpaperDirectorySource", "Local folder") },
          ]}
          onChange={(source) => {
            setDraftSource(source as "url" | "directory");
            setError(null);
          }}
        />
        {draftSource === "url" ? (
          <Input
            value={draftUrl}
            onChange={(event) => {
              setDraftUrl(event.target.value);
              setError(null);
            }}
            placeholder={tx("settings.placeholders.wallpaperUrl", "Image URL")}
            className="h-9 rounded-full bg-background/80 text-[12.5px]"
          />
        ) : (
          <>
            <div className="flex w-full items-center gap-2">
              <Input
                value={draftDirectory}
                onChange={(event) => {
                  setDraftDirectory(event.target.value);
                  setError(null);
                }}
                placeholder={tx("settings.placeholders.wallpaperDirectory", "Image folder")}
                className="h-9 min-w-0 flex-1 rounded-full bg-background/80 text-[12.5px]"
              />
              <Button type="button" variant="outline" onClick={() => void chooseDirectory()}>
                {tx("settings.actions.chooseFolder", "Choose")}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{tx("settings.rows.wallpaperOrder", "Order")}</span>
              <SegmentedControl
                value={draftOrder}
                options={[
                  { value: "sequential", label: tx("settings.values.sequential", "Sequential") },
                  { value: "random", label: tx("settings.values.random", "Random") },
                ]}
                onChange={(order) => {
                  setDraftOrder(order as "sequential" | "random");
                  setError(null);
                }}
              />
            </div>
          </>
        )}
        <div className="flex w-full flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">
              {tx("settings.rows.wallpaperInterval", "Update every (minutes)")}
            </span>
            <Input
              type="number"
              min={1}
              step={1}
              value={draftInterval}
              onChange={(event) => {
                setDraftInterval(Number(event.target.value));
                setError(null);
              }}
              className="h-9 w-24 rounded-full bg-background/80 text-[12.5px]"
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            disabled={saving || !dirty}
            onClick={() => void handleSave()}
          >
            {saving ? t("settings.actions.saving") : t("settings.actions.save")}
          </Button>
        </div>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function RaiseInboxShortcutRow({
  tx,
}: {
  tx: (key: string, fallback: string) => string;
}) {
  const { t } = useTranslation();
  const displayPlatform = window.electronAPI.platform.isMac ? "mac" : "windows";
  const [savedElectron, setSavedElectron] = useState("CmdOrCtrl+Shift+E");
  const [draftHotkey, setDraftHotkey] = useState<Hotkey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const savedHotkey = useMemo(
    () => electronAcceleratorToHotkey(savedElectron),
    [savedElectron],
  );
  const activeHotkey = draftHotkey ?? savedHotkey;
  const pendingElectron = hotkeyToElectronAccelerator(activeHotkey);

  const setGlobalShortcutPaused = useCallback(async (paused: boolean) => {
    await window.electronAPI.shortcut.setRaiseInboxRecording(paused);
  }, []);

  const endRecording = useCallback(async () => {
    await setGlobalShortcutPaused(false);
  }, [setGlobalShortcutPaused]);

  const recorder = useHotkeyRecorder({
    ignoreInputs: false,
    onRecord: (hotkey) => {
      setDraftHotkey(hotkey);
      setError(null);
      void endRecording();
    },
    onCancel: () => {
      setDraftHotkey(null);
      void endRecording();
    },
  });

  const beginRecording = useCallback(async () => {
    setError(null);
    await setGlobalShortcutPaused(true);
    recorder.startRecording();
  }, [recorder, setGlobalShortcutPaused]);

  useEffect(() => {
    window.electronAPI.shortcut.getRaiseInbox().then((accelerator) => {
      setSavedElectron(accelerator);
      setDraftHotkey(null);
    }).catch(() => { /* ignore load errors */ });
  }, []);

  useEffect(() => {
    return () => {
      void setGlobalShortcutPaused(false);
    };
  }, [setGlobalShortcutPaused]);

  const handleSave = useCallback(async () => {
    const accelerator = pendingElectron.trim();
    if (!accelerator) {
      setError(t("settings.errors.raiseInboxShortcutEmpty"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.shortcut.setRaiseInbox(accelerator);
      if ("accelerator" in result) {
        setSavedElectron(result.accelerator);
        setDraftHotkey(null);
      } else if (result.error === "empty") {
        setError(t("settings.errors.raiseInboxShortcutEmpty"));
      } else {
        setError(t("settings.errors.raiseInboxShortcutRegisterFailed"));
      }
    } catch {
      setError(t("settings.errors.raiseInboxShortcutRegisterFailed"));
    } finally {
      setSaving(false);
    }
  }, [pendingElectron, t]);

  const dirty = pendingElectron.trim() !== savedElectron.trim();
  const displayLabel = recorder.isRecording
    ? t("settings.shortcut.recording")
    : formatForDisplay(activeHotkey, { platform: displayPlatform });

  return (
    <SettingsRow
      title={tx("settings.rows.raiseInboxShortcut", "Raise inbox shortcut")}
      description={tx(
        "settings.help.raiseInboxShortcut",
        "Global shortcut to show the main window, open the unified inbox, and focus the composer. Click Record, press a key combination, then Save.",
      )}
    >
      <div className="flex w-full flex-col gap-2">
        <div className="flex w-full flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className={cn(
              "min-w-[10rem] flex-1 justify-center font-mono text-xs",
              recorder.isRecording && "ring-2 ring-primary",
            )}
            aria-label={tx("settings.rows.raiseInboxShortcut", "Raise inbox shortcut")}
            onClick={() => {
              if (recorder.isRecording) {
                recorder.cancelRecording();
              } else {
                void beginRecording();
              }
            }}
          >
            {displayLabel}
          </Button>
          {recorder.isRecording ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => recorder.cancelRecording()}
            >
              {t("settings.actions.cancel")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={saving || !dirty}
            onClick={() => void handleSave()}
          >
            {saving ? t("settings.actions.saving") : t("settings.actions.save")}
          </Button>
        </div>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsRow>
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
