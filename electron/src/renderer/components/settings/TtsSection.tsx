import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsPayload } from "@/lib/types";
import { updateTtsSettings } from "@/lib/api";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
} from "./shared";

interface TtsSectionProps {
  settings: SettingsPayload;
  token: string;
  apiBase: string;
  onSaved: () => void;
}

export function TtsSection({ settings, token, apiBase, onSaved }: TtsSectionProps) {
  const { t } = useTranslation();
  const tts = settings.tts;

  const [mode, setMode] = useState(tts.mode);
  const [preset, setPreset] = useState(tts.preset ?? "");
  const [voice, setVoice] = useState(tts.voice ?? "");
  const [saving, setSaving] = useState(false);
  const activePreset = tts.presets.find((item) => item.id === preset);

  const handleSave = async (update: Record<string, unknown>) => {
    setSaving(true);
    try {
      await updateTtsSettings(token, update, apiBase);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSectionTitle>
        {t("settings.tts.title", "TTS 语音合成")}
      </SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow
          title={t("settings.tts.mode", "语音模式")}
          description={t("settings.tts.modeDesc", "关闭、由 AI 决定，或每轮完整回复自动朗读")}
        >
          <select
            value={mode}
            disabled={saving}
            className="w-48 rounded-md border border-border bg-input px-3 py-1.5 text-sm"
            onChange={(event) => {
              const value = event.target.value as typeof mode;
              setMode(value);
              void handleSave({ mode: value });
            }}
          >
            <option value="off">{t("settings.tts.modeOff", "关闭")}</option>
            <option value="agent">{t("settings.tts.modeAgent", "由 AI 决定")}</option>
            <option value="always">{t("settings.tts.modeAlways", "始终朗读")}</option>
          </select>
        </SettingsRow>

        <SettingsRow
          title={t("settings.tts.preset", "TTS 服务")}
          description={t("settings.tts.presetDesc", "选择语音服务；连接参数由预设配置管理")}
        >
          <select
            value={preset}
            disabled={saving || tts.presets.length === 0}
            className="w-48 rounded-md border border-border bg-input px-3 py-1.5 text-sm"
            onChange={(event) => {
              const nextPreset = event.target.value;
              const nextVoice = tts.presets.find((item) => item.id === nextPreset)?.voices[0]?.id ?? "";
              setPreset(nextPreset);
              setVoice(nextVoice);
              void handleSave({ preset: nextPreset, voice: nextVoice });
            }}
          >
            {tts.presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </SettingsRow>

        <SettingsRow
          title={t("settings.tts.voice", "音色")}
          description={t("settings.tts.voiceDesc", "同一音色可按语言使用预设中的不同声线")}
        >
          <select
            value={voice}
            disabled={saving || !activePreset}
            className="w-48 rounded-md border border-border bg-input px-3 py-1.5 text-sm"
            onChange={(event) => {
              const nextVoice = event.target.value;
              setVoice(nextVoice);
              void handleSave({ preset, voice: nextVoice });
            }}
          >
            {activePreset?.voices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
