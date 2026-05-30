import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingsPayload } from "@/lib/types";
import {
  ReadOnlyRow,
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
} from "./shared";

interface AdvancedSectionProps {
  settings: SettingsPayload;
}

export function AdvancedSection({ settings }: AdvancedSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{tx("settings.sections.safety", "Safety")}</SettingsSectionTitle>
        <SettingsGroup>
          <ReadOnlyRow
            title={tx("settings.rows.restrictWorkspace", "Restrict to workspace")}
            value={
              settings.advanced.restrict_to_workspace
                ? tx("settings.values.enabled", "Enabled")
                : tx("settings.values.disabled", "Disabled")
            }
          />
          <ReadOnlyRow
            title={tx("settings.rows.execTool", "Exec tool")}
            value={
              settings.advanced.exec_enabled
                ? tx("settings.values.enabled", "Enabled")
                : tx("settings.values.disabled", "Disabled")
            }
          />
          <ReadOnlyRow
            title={tx("settings.rows.execSandbox", "Exec sandbox")}
            value={settings.advanced.exec_sandbox ?? tx("settings.values.notAvailable", "Not available")}
          />
          <ReadOnlyRow
            title={tx("settings.rows.ssrfWhitelist", "SSRF whitelist")}
            value={String(settings.advanced.ssrf_whitelist_count)}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>
          {tx("settings.sections.integrations", "Integrations")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <ReadOnlyRow
            title={tx("settings.rows.mcpServers", "MCP servers")}
            value={String(settings.advanced.mcp_server_count)}
          />
          <ReadOnlyRow
            title={tx("settings.rows.pathAppend", "PATH append")}
            value={
              settings.advanced.exec_path_append_set
                ? tx("settings.values.configured", "Configured")
                : tx("settings.values.notConfigured", "Not configured")
            }
          />
          <SettingsRow
            title={tx("settings.rows.configurationDocs", "Configuration docs")}
            description={tx(
              "settings.help.advancedReadOnly",
              "Advanced safety controls are read-only in the app. Edit config.json intentionally when needed.",
            )}
          >
            <a
              className="inline-flex h-8 items-center rounded-full border border-input bg-background px-3 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
              href="https://github.com/HKUDS/nanobot/blob/main/docs/configuration.md"
              target="_blank"
              rel="noreferrer"
            >
              <Info className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {tx("settings.actions.openDocs", "Open docs")}
            </a>
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
