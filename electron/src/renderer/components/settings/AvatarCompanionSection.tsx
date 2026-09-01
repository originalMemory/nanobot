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
};

const DEFAULT_PREFS: AvatarCompanionPrefs = {
  enabled: false,
  livetalking: true,
  serverUrl: "http://127.0.0.1:8010",
  timeoutMs: 3000,
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
        </SettingsGroup>
      </section>
    </div>
  );
}
