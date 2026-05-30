import { Blocks, Bot, Globe2, HardDrive, ImageIcon, Loader2, RotateCcw, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { providerDisplayLabel } from "@/lib/provider-brand";
import type { CliAppsPayload, McpPresetsPayload, SettingsPayload } from "@/lib/types";
import {
  OverviewListRow,
  SettingsGroup,
  SettingsSectionTitle,
  StatusPill,
  type SettingsSectionKey,
} from "./shared";

interface OverviewSectionProps {
  settings: SettingsPayload;
  requiresRestart: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onSelectSection: (section: SettingsSectionKey) => void;
  showBrandLogos: boolean;
  cliApps: CliAppsPayload | null;
  mcpPresets: McpPresetsPayload | null;
}

export function OverviewSection({
  settings,
  requiresRestart,
  onRestart,
  isRestarting,
  onSelectSection,
  showBrandLogos,
  cliApps,
  mcpPresets,
}: OverviewSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const activePreset = settings.agent.model_preset || "default";
  const activeProvider = settings.agent.resolved_provider ?? settings.agent.provider;
  const webStatus = settings.web.enable
    ? tx("settings.values.enabled", "Enabled")
    : tx("settings.values.disabled", "Disabled");
  const imageStatus = settings.image_generation.enabled
    ? tx("settings.values.enabled", "Enabled")
    : tx("settings.values.disabled", "Disabled");
  const imageCaption = `${providerDisplayLabel(settings.image_generation.providers, settings.image_generation.provider)} · ${
    settings.image_generation.provider_configured
      ? tx("settings.values.configured", "Configured")
      : tx("settings.values.notConfigured", "Not configured")
  }`;
  const cliAppsEnabledCount = cliApps?.installed_count ?? 0;
  const mcpAppsEnabledCount = mcpPresets?.installed_count ?? settings.advanced.mcp_server_count;
  const appsCount = cliAppsEnabledCount + mcpAppsEnabledCount;
  const appsValue = tx("settings.apps.enabledSummary", "{{count}} enabled").replace(
    "{{count}}",
    String(appsCount),
  );
  const appsCaption = tx("settings.apps.caption", "{{cli}} CLI · {{mcp}} MCP")
    .replace("{{cli}}", String(cliAppsEnabledCount))
    .replace("{{mcp}}", String(mcpAppsEnabledCount));

  return (
    <div className="space-y-7">
      <section>
        <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-muted-foreground">nanobot</div>
                <div className="mt-0.5 truncate text-[18px] font-semibold leading-6 text-foreground">
                  {settings.agent.model}
                </div>
                <div className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">
                  {activeProvider} · {activePreset}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <StatusPill tone={requiresRestart ? "neutral" : "success"}>
                {requiresRestart
                  ? tx("settings.values.restartPending", "Restart pending")
                  : tx("settings.values.ready", "Ready")}
              </StatusPill>
              {requiresRestart && onRestart ? (
                <Button
                  size="sm"
                  variant="ghost"
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
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.ai", "AI")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Bot}
            valueLogoProvider={activeProvider}
            title={tx("settings.overview.model", "Current model")}
            value={settings.agent.model}
            caption={`${activeProvider} · ${activePreset}`}
            showBrandLogos={showBrandLogos}
            onClick={() => onSelectSection("models")}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.capabilities", "Capabilities")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Globe2}
            valueLogoProvider={settings.web_search.provider}
            title={tx("settings.overview.webSearch", "Web search")}
            value={providerDisplayLabel(settings.web_search.providers, settings.web_search.provider)}
            caption={webStatus}
            showBrandLogos={showBrandLogos}
            onClick={() => onSelectSection("web")}
          />
          <OverviewListRow
            icon={ImageIcon}
            valueLogoProvider={settings.image_generation.provider}
            title={tx("settings.overview.imageGeneration", "Image generation")}
            value={imageStatus}
            caption={imageCaption}
            showBrandLogos={showBrandLogos}
            onClick={() => onSelectSection("image")}
          />
          <OverviewListRow
            icon={Blocks}
            title={tx("settings.nav.apps", "Apps")}
            value={appsValue}
            caption={appsCaption}
            onClick={() => onSelectSection("apps")}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.system", "System")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Server}
            title={tx("settings.rows.gateway", "Gateway")}
            value={`${settings.runtime.gateway_host}:${settings.runtime.gateway_port}`}
            caption={
              requiresRestart
                ? tx("settings.values.restartPending", "Restart pending")
                : tx("settings.values.ready", "Ready")
            }
            onClick={() => onSelectSection("runtime")}
          />
          <OverviewListRow
            icon={HardDrive}
            title={tx("settings.overview.workspace", "Workspace")}
            value={settings.runtime.workspace_path}
            caption={settings.runtime.config_path}
            onClick={() => onSelectSection("runtime")}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
