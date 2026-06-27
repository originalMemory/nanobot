import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsPayload } from "@/lib/types";
import { updateTtsSettings } from "@/lib/api";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  ToggleButton,
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

  const [enabled, setEnabled] = useState(tts.enabled);
  const [messagePlayback, setMessagePlayback] = useState(tts.message_playback_enabled);
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
          title={t("settings.tts.enabled", "启用 TTS")}
          description={t("settings.tts.enabledDesc", "允许 AI 主动合成语音")}
        >
          <ToggleButton
            checked={enabled}
            disabled={saving}
            onChange={(v) => {
              setEnabled(v);
              void handleSave({ enabled: v });
            }}
          />
        </SettingsRow>

        <SettingsRow
          title={t("settings.tts.messagePlayback", "自动语音播放")}
          description={t("settings.tts.messagePlaybackDesc", "每条回复自动按句合成并播放 TTS")}
        >
          <ToggleButton
            checked={messagePlayback}
            disabled={saving}
            onChange={(v) => {
              setMessagePlayback(v);
              void handleSave({ message_playback_enabled: v });
            }}
          />
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
