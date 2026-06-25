import { useState } from "react";
import { ExternalLink, RefreshCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SettingsPayload, ThaSettingsUpdate } from "@/lib/types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  ToggleButton,
} from "./shared";

interface ThaSectionProps {
  settings: SettingsPayload;
  token: string;
  apiBase: string;
  onSave: (update: ThaSettingsUpdate) => Promise<void>;
}

export function ThaSection({ settings, token, apiBase, onSave }: ThaSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const config = settings.deskPet.tha.config;
  const model = settings.deskPet.tha.model;
  const [, setSaving] = useState(false);

  const toggleLabel = (checked: boolean) =>
    checked ? tx("settings.values.enabled", "Enabled") : tx("settings.deskPet.common.toggleOff", "Off");

  async function save(update: ThaSettingsUpdate) {
    setSaving(true);
    try {
      await onSave(update);
    } finally {
      setSaving(false);
    }
  }

  function openTha() {
    const width = config.windowWidth;
    const height = config.windowHeight;
    if (window.electronAPI?.tha) {
      void window.electronAPI.tha.open({ url: apiBase, token, width, height });
      return;
    }
    const url = new URL("/tha.html", apiBase);
    url.searchParams.set("token", token);
    window.open(url.toString(), "_blank", `width=${width},height=${height}`);
  }

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{tx("settings.deskPet.tha.behaviorSection", "Behavior")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.deskPet.tha.launch", "Launch THA")}
            description={tx(
              "settings.deskPet.tha.launchDescription",
              "Open the standalone 2D desk pet page; in Electron this creates a transparent always-on-top window.",
            )}
          >
            <Button type="button" size="sm" onClick={openTha} className="gap-2">
              <ExternalLink className="h-4 w-4" aria-hidden />
              {tx("settings.deskPet.common.open", "Open")}
            </Button>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.deskPet.tha.emotionTags", "Emotion tags")}
            description={tx(
              "settings.deskPet.tha.emotionTagsDescription",
              "Allow the model to output <happy> / <nod> tags to drive THA.",
            )}
          >
            <ToggleButton
              checked={config.enabledEmotions}
              label={toggleLabel(config.enabledEmotions)}
              onChange={(enabledEmotions) => save({ enabledEmotions })}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.deskPet.tha.mouthSync", "Mouth sync")}
            description={tx(
              "settings.deskPet.tha.mouthSyncDescription",
              "THA page plays audio and analyzes volume to drive the mouth.",
            )}
          >
            <ToggleButton
              checked={config.enabledMouthSync}
              label={toggleLabel(config.enabledMouthSync)}
              onChange={(enabledMouthSync) => save({ enabledMouthSync })}
            />
          </SettingsRow>
          <SettingsRow
            title={
              model.available
                ? tx("settings.deskPet.tha.modelReady", "Model ready")
                : tx("settings.deskPet.tha.modelMissing", "Model not found")
            }
            description={tx(
              "settings.deskPet.tha.modelPathDescription",
              "Reads tha_model/model.mlpackage or tha_model/model.onnx; replace that file to swap models.",
            )}
          >
            <span className="block max-w-[360px] truncate text-right text-[13px] text-muted-foreground">
              {model.available ? `${model.format} · ${model.path}` : model.path}
            </span>
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.deskPet.tha.windowSection", "Window")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow title={tx("settings.deskPet.tha.windowSize", "Window size")}>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={240}
                max={2400}
                value={config.windowWidth}
                onChange={(event) => save({ windowWidth: Number(event.target.value) })}
                className="w-24"
                aria-label={tx("settings.deskPet.tha.windowSize", "Window size")}
              />
              <span className="text-xs text-muted-foreground">×</span>
              <Input
                type="number"
                min={240}
                max={2400}
                value={config.windowHeight}
                onChange={(event) => save({ windowHeight: Number(event.target.value) })}
                className="w-24"
                aria-label={tx("settings.deskPet.tha.windowSize", "Window size")}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.deskPet.tha.audioDelay", "Audio delay")}
            description={tx(
              "settings.deskPet.tha.audioDelayDescription",
              "Compensates mouth command, backend rendering, and JPEG return latency when using a remote gateway.",
            )}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={2000}
                value={config.audioDelayMs}
                onChange={(event) => save({ audioDelayMs: Number(event.target.value) })}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground">ms</span>
            </div>
          </SettingsRow>
          <SettingsRow title={tx("settings.deskPet.tha.closeWindows", "Close THA window")}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void window.electronAPI?.tha?.closeAll()}
            >
              <RefreshCcw className="h-4 w-4" aria-hidden />
              {tx("settings.deskPet.common.closeAll", "Close all")}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
