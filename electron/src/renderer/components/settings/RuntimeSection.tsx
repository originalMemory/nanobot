import { useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SettingsPayload, SettingsUpdate } from "@/lib/types";
import {
  NumberInput,
  ReadOnlyRow,
  RestartSettingsFooter,
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  TimezonePicker,
} from "./shared";

interface RuntimeSectionProps {
  settings: SettingsPayload;
  pendingRestart: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onSave: (update: SettingsUpdate) => Promise<void>;
}

export function RuntimeSection({
  settings,
  pendingRestart,
  onRestart,
  isRestarting,
  onSave,
}: RuntimeSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const [form, setForm] = useState({
    botName: settings.agent.bot_name,
    botIcon: settings.agent.bot_icon,
    timezone: settings.agent.timezone,
    toolHintMaxLength: settings.agent.tool_hint_max_length,
  });
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(
    () =>
      form.timezone !== settings.agent.timezone ||
      form.botName !== settings.agent.bot_name ||
      form.botIcon !== settings.agent.bot_icon ||
      form.toolHintMaxLength !== settings.agent.tool_hint_max_length,
    [form, settings],
  );

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await onSave({
        timezone: form.timezone,
        botName: form.botName,
        botIcon: form.botIcon,
        toolHintMaxLength: form.toolHintMaxLength,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{tx("settings.sections.identity", "Identity")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.botName", "Bot name")}
            description={tx(
              "settings.help.botName",
              "Shown in runtime surfaces that use the configured bot identity.",
            )}
          >
            <Input
              value={form.botName}
              onChange={(e) => setForm((prev) => ({ ...prev, botName: e.target.value }))}
              className="h-8 w-[220px] rounded-full text-[13px]"
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.botIcon", "Bot icon")}
            description={tx(
              "settings.help.botIcon",
              "Short emoji or text shown beside the bot name.",
            )}
          >
            <Input
              value={form.botIcon}
              onChange={(e) => setForm((prev) => ({ ...prev, botIcon: e.target.value }))}
              className="h-8 w-[120px] rounded-full text-center text-[13px]"
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.timezone", "Timezone")}
            description={tx(
              "settings.help.timezone",
              "IANA timezone used by runtime context and schedules.",
            )}
          >
            <TimezonePicker
              value={form.timezone}
              onChange={(timezone) => setForm((prev) => ({ ...prev, timezone }))}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.toolHintMaxLength", "Tool hint max length")}
            description={tx(
              "settings.help.toolHintMaxLength",
              "Maximum characters of tool output included as context hints.",
            )}
          >
            <NumberInput
              value={form.toolHintMaxLength}
              min={0}
              max={100000}
              onChange={(toolHintMaxLength) => setForm((prev) => ({ ...prev, toolHintMaxLength }))}
              suffix={tx("settings.values.chars", "chars")}
            />
          </SettingsRow>

          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={pendingRestart}
            dirtyMessage={tx(
              "settings.status.restartAfterSaving",
              "Save changes, then restart when ready.",
            )}
            pendingMessage={tx("settings.status.savedRestartApply", "Saved. Restart when ready.")}
            onSave={() => void handleSave()}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{t("settings.sections.system")}</SettingsSectionTitle>
        <SettingsGroup>
          {onRestart && !pendingRestart ? (
            <SettingsRow
              title={t("settings.rows.restart")}
              description={t("app.system.restartHint")}
            >
              <Button
                size="sm"
                variant="outline"
                onClick={onRestart}
                disabled={isRestarting}
                className="rounded-full"
              >
                {isRestarting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                {isRestarting ? t("app.system.restarting") : t("app.system.restart")}
              </Button>
            </SettingsRow>
          ) : null}
          <ReadOnlyRow
            title={t("settings.rows.configPath")}
            value={settings.runtime.config_path}
          />
          <ReadOnlyRow
            title={tx("settings.rows.workspacePath", "Workspace path")}
            value={settings.runtime.workspace_path}
          />
          <ReadOnlyRow
            title={tx("settings.rows.heartbeat", "Heartbeat")}
            value={
              settings.runtime.heartbeat.enabled
                ? settings.runtime.unified_session
                  ? `${settings.runtime.heartbeat.interval_s}s · ctx ${settings.runtime.heartbeat.context_messages}`
                  : `${settings.runtime.heartbeat.interval_s}s`
                : tx("settings.values.disabled", "Disabled")
            }
          />
          <ReadOnlyRow
            title={tx("settings.rows.dream", "Dream")}
            value={settings.runtime.dream.schedule}
          />
          <ReadOnlyRow
            title={tx("settings.rows.unifiedSession", "Unified session")}
            value={
              settings.runtime.unified_session
                ? tx("settings.values.enabled", "Enabled")
                : tx("settings.values.disabled", "Disabled")
            }
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
