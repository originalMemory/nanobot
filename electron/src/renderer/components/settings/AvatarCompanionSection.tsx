import { useCallback, useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notifyAvatarCompanionPrefsChanged } from "@/lib/avatar-companion-events";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  StatusPill,
  ToggleButton,
} from "./shared";

type AvatarCompanionPrefs = {
  enabled: boolean;
  livetalking: boolean;
  serverUrl: string;
  timeoutMs: number;
  videoDirectory: string;
  timeSchedule: { sunrise: string; day: string; sunset: string; night: string };
};

const DEFAULT_PREFS: AvatarCompanionPrefs = {
  enabled: false,
  livetalking: true,
  serverUrl: "http://127.0.0.1:8010",
  timeoutMs: 3000,
  videoDirectory: "",
  timeSchedule: { sunrise: "05:00", day: "10:00", sunset: "18:00", night: "22:00" },
};

function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function AvatarCompanionSection() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [prefs, setPrefs] = useState<AvatarCompanionPrefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<{ reachable: boolean; lastError: string | null } | null>(null);
  const [videoDirectoryError, setVideoDirectoryError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.config?.get) return;
    void api.config.get("avatarCompanion").then((stored) => {
      const partial = (stored ?? {}) as Partial<AvatarCompanionPrefs>;
      setPrefs({
        enabled: partial.enabled ?? DEFAULT_PREFS.enabled,
        livetalking: partial.livetalking ?? DEFAULT_PREFS.livetalking,
        serverUrl: partial.serverUrl ?? DEFAULT_PREFS.serverUrl,
        timeoutMs: partial.timeoutMs ?? DEFAULT_PREFS.timeoutMs,
        videoDirectory: partial.videoDirectory ?? DEFAULT_PREFS.videoDirectory,
        timeSchedule: { ...DEFAULT_PREFS.timeSchedule, ...(partial.timeSchedule ?? {}) },
      });
      setLoaded(true);
    });
  }, []);

  const savePrefs = useCallback(async (patch: Partial<AvatarCompanionPrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    const api = window.electronAPI;
    if (!api?.config?.set) return;
    const stored = (await api.config.get("avatarCompanion")) as Partial<AvatarCompanionPrefs> | undefined;
    await api.config.set("avatarCompanion", { ...DEFAULT_PREFS, ...stored, ...patch });
    notifyAvatarCompanionPrefsChanged();
    if (patch.videoDirectory !== undefined) {
      const result = await api.livetalking.localVideos();
      setVideoDirectoryError(result.directoryError);
    }
  }, []);

  async function checkHealth() {
    const api = window.electronAPI?.livetalking;
    if (!api) return;
    setChecking(true);
    try {
      const result = await api.checkHealth();
      setHealth({ reachable: result.reachable, lastError: result.lastError });
    } finally {
      setChecking(false);
    }
  }

  async function chooseVideoDirectory() {
    const directory = await window.electronAPI?.wallpaper.chooseDirectory();
    if (directory) await savePrefs({ videoDirectory: directory });
  }

  const loopbackValid = isLoopbackUrl(prefs.serverUrl);
  const toggleLabel = (checked: boolean) =>
    checked ? tx("settings.values.enabled", "Enabled") : tx("settings.deskPet.common.toggleOff", "Off");

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>
          {tx("settings.avatarCompanion.serviceSection", "LiveTalking service")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.avatarCompanion.enable", "Enable avatar companion")}
            description={tx(
              "settings.avatarCompanion.enableDescription",
              "Show the avatar companion window; idle/working animations stay independent of chat.",
            )}
          >
            <ToggleButton
              checked={prefs.enabled}
              label={toggleLabel(prefs.enabled)}
              onChange={(enabled) => void savePrefs({ enabled })}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.avatarCompanion.livetalking", "LiveTalking speech")}
            description={tx(
              "settings.avatarCompanion.livetalkingDescription",
              "Route only the speaking part to the LiveTalking avatar. When off, the companion still shows and voice plays normally.",
            )}
          >
            <ToggleButton
              checked={prefs.livetalking}
              label={toggleLabel(prefs.livetalking)}
              onChange={(livetalking) => void savePrefs({ livetalking })}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.avatarCompanion.serverUrl", "Server URL")}
            description={tx(
              "settings.avatarCompanion.serverUrlDescription",
              "LiveTalking local service address. Only loopback addresses are accepted.",
            )}
          >
            <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
              <Input
                value={prefs.serverUrl}
                onChange={(event) => void savePrefs({ serverUrl: event.target.value.trim() })}
                className="w-64"
                aria-label={tx("settings.avatarCompanion.serverUrl", "Server URL")}
              />
              {!loopbackValid ? (
                <StatusPill tone="warning">
                  {tx("settings.avatarCompanion.nonLoopback", "Loopback only")}
                </StatusPill>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-2"
                disabled={!loaded || !loopbackValid || checking}
                onClick={() => void checkHealth()}
              >
                <RefreshCcw className="h-4 w-4" aria-hidden />
                {tx("settings.avatarCompanion.checkConnection", "Check")}
              </Button>
            </div>
          </SettingsRow>
          {health ? (
            <SettingsRow
              title={tx("settings.avatarCompanion.connectionStatus", "Connection status")}
              description={health.lastError ?? undefined}
            >
              <StatusPill tone={health.reachable ? "success" : "warning"}>
                {health.reachable
                  ? tx("settings.avatarCompanion.reachable", "Reachable")
                  : tx("settings.avatarCompanion.unreachable", "Unreachable")}
              </StatusPill>
            </SettingsRow>
          ) : null}
          <SettingsRow
            title={tx("settings.avatarCompanion.timeout", "Timeout (ms)")}
            description={tx(
              "settings.avatarCompanion.timeoutDescription",
              "Health check and audio submission timeout.",
            )}
          >
            <Input
              type="number"
              min={500}
              max={30000}
              value={prefs.timeoutMs}
              onChange={(event) => void savePrefs({ timeoutMs: Number(event.target.value) })}
              className="w-28"
              aria-label={tx("settings.avatarCompanion.timeout", "Timeout (ms)")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.avatarCompanion.videoDirectory", "Video directory")}
            description={tx(
              "settings.avatarCompanion.videoDirectoryDescription",
              "Choose a scene-pack directory containing idle/ and working/ folders.",
            )}
          >
            <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
              <Input
                value={prefs.videoDirectory}
                onChange={(event) => setPrefs((current) => ({ ...current, videoDirectory: event.target.value }))}
                onBlur={(event) => void savePrefs({ videoDirectory: event.currentTarget.value.trim() })}
                className="w-80"
                aria-label={tx("settings.avatarCompanion.videoDirectory", "Video directory")}
              />
              <Button type="button" size="sm" variant="outline" onClick={() => void chooseVideoDirectory()}>
                {tx("settings.avatarCompanion.chooseDirectory", "Browse")}
              </Button>
              {videoDirectoryError ? (
                <StatusPill tone="warning">
                  {tx(`settings.avatarCompanion.videoDirectoryError.${videoDirectoryError}`, videoDirectoryError)}
                </StatusPill>
              ) : null}
            </div>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.avatarCompanion.timeSchedule", "Time periods")}
            description={tx(
              "settings.avatarCompanion.timeScheduleDescription",
              "Set the local start time for each video period (HH:mm).",
            )}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["sunrise", "day", "sunset", "night"] as const).map((segment) => (
                <label key={segment} className="text-xs text-muted-foreground">
                  {tx(`settings.avatarCompanion.${segment}`, segment)}
                  <Input
                    type="time"
                    value={prefs.timeSchedule[segment]}
                    onChange={(event) => void savePrefs({ timeSchedule: { ...prefs.timeSchedule, [segment]: event.target.value } })}
                    aria-label={segment}
                  />
                </label>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
