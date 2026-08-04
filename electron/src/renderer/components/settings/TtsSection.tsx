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
  const [defaultVoice, setDefaultVoice] = useState(tts.default_voice);
  const [saving, setSaving] = useState(false);

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
          title={t("settings.tts.defaultVoice", "默认音色")}
          description={t("settings.tts.defaultVoiceDesc", "音色名称或 voice_id（如：坎蒂丝 / tongtong）")}
        >
          <input
            type="text"
            value={defaultVoice}
            disabled={saving}
            className="w-48 rounded-md border border-border bg-input px-3 py-1.5 text-sm"
            placeholder="坎蒂丝"
            onChange={(e) => setDefaultVoice(e.target.value)}
            onBlur={() => void handleSave({ default_voice: defaultVoice })}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
