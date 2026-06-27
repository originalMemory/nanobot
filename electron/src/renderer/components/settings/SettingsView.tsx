import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCliApps,
  fetchMcpPresets,
  fetchSettings,
  importMcpConfig,
  runCliAppAction,
  runMcpPresetAction,
  saveCustomMcpServer,
  updateMcpServerTools,
  updateProviderSettings,
  updateSettings,
  updateWebSearchSettings,
  updateImageGenerationSettings,
  updateThaSettings,
  updateDeskPetPsbSettings,
  createModelConfiguration,
} from "@/lib/api";
import type {
  CliAppsPayload,
  ImageGenerationSettingsUpdate,
  McpPresetsPayload,
  ProviderSettingsUpdate,
  SettingsPayload,
  SettingsUpdate,
  ThaSettingsUpdate,
  PsbSettingsUpdate,
  WebSearchSettingsUpdate,
} from "@/lib/types";
import type { ReasoningEffortValue } from "@/lib/reasoning-effort";
import { useClient } from "@/providers/ClientProvider";
import type { Theme } from "@/hooks/useTheme";
import { useElectronPreference } from "@/hooks/useElectronPreference";
import { DEFAULT_LOCAL_PREFS, type LocalPreferences, type SettingsSectionKey } from "./shared";
import { SettingsLayout } from "./SettingsLayout";
import { OverviewSection } from "./OverviewSection";
import { AppearanceSection } from "./AppearanceSection";
import { ModelsSection, type AgentSettingsDraft } from "./ModelsSection";
import { ImageSection } from "./ImageSection";
import { WebSection } from "./WebSection";
import { AppsSection } from "./AppsSection";
import { RuntimeSection } from "./RuntimeSection";
import { AdvancedSection } from "./AdvancedSection";
import { DeskPetSection } from "./DeskPetSection";
import { TtsSection } from "./TtsSection";

interface ProviderForm {
  apiKey: string;
  apiBase: string;
  apiType: string;
}

interface ModelConfigurationDraft {
  name?: string;
  label: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortValue;
}

// ---------------------------------------------------------------------------
// Custom MCP form shape (mirrored from AppsSection for decoupled imports)
// ---------------------------------------------------------------------------

interface CustomMcpForm {
  name: string;
  transport: "stdio" | "streamableHttp" | "sse";
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  toolTimeout: string;
}

// ---------------------------------------------------------------------------
// SettingsView
// ---------------------------------------------------------------------------

interface SettingsViewProps {
  onBack: () => void;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onSettingsChange?: (settings: SettingsPayload) => void;
  navigateSection?: SettingsSectionKey | null;
}

export function SettingsView({
  onBack,
  theme,
  onThemeChange,
  onSettingsChange,
  navigateSection,
}: SettingsViewProps) {
  const { token, apiBase } = useClient();
  const [localPrefs, setLocalPrefs] = useElectronPreference<LocalPreferences>(
    "appearance.preferences",
    DEFAULT_LOCAL_PREFS,
  );
  const showBrandLogos = localPrefs.brandLogos;

  // ---------- section state ----------
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>("overview");

  useEffect(() => {
    if (navigateSection) setActiveSection(navigateSection);
  }, [navigateSection]);

  // ---------- settings data ----------
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // ---------- cli / mcp data ----------
  const [cliApps, setCliApps] = useState<CliAppsPayload | null>(null);
  const [mcpPresets, setMcpPresets] = useState<McpPresetsPayload | null>(null);
  const [cliAppsLoading, setCliAppsLoading] = useState(true);
  const [mcpPresetsLoading, setMcpPresetsLoading] = useState(true);

  // ---------- restart state ----------
  const [isRestarting, setIsRestarting] = useState(false);
  const { client } = useClient();
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -----------------------------------------------------------------------
  // Initial data load
  // -----------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setSettingsLoading(true);
    setSettingsError(null);
    fetchSettings(token, apiBase)
      .then((data) => {
        if (!cancelled) {
          setSettings(data);
          onSettingsChange?.(data);
          setSettingsLoading(false);
        }
      })
      .catch((err) => { if (!cancelled) { setSettingsError((err as Error).message); setSettingsLoading(false); } });
    return () => { cancelled = true; };
  }, [token, apiBase, onSettingsChange]);

  useEffect(() => {
    let cancelled = false;
    setCliAppsLoading(true);
    fetchCliApps(token, apiBase)
      .then((data) => { if (!cancelled) { setCliApps(data); setCliAppsLoading(false); } })
      .catch(() => { if (!cancelled) setCliAppsLoading(false); });
    return () => { cancelled = true; };
  }, [token, apiBase]);

  useEffect(() => {
    let cancelled = false;
    setMcpPresetsLoading(true);
    fetchMcpPresets(token, apiBase)
      .then((data) => { if (!cancelled) { setMcpPresets(data); setMcpPresetsLoading(false); } })
      .catch(() => { if (!cancelled) setMcpPresetsLoading(false); });
    return () => { cancelled = true; };
  }, [token, apiBase]);

  useEffect(() => {
    return () => { if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current); };
  }, []);

  // -----------------------------------------------------------------------
  // Restart
  // -----------------------------------------------------------------------

  const handleRestart = useCallback(() => {
    setIsRestarting(true);
    try {
      client.sendMessage("system", "/restart");
    } catch {
      // ignore – restart disconnects the socket
    }
    restartTimeoutRef.current = setTimeout(() => setIsRestarting(false), 8000);
  }, [client]);

  // -----------------------------------------------------------------------
  // Settings update helpers
  // -----------------------------------------------------------------------

  const handleSettingsUpdate = useCallback((payload: SettingsPayload) => {
    setSettings(payload);
    onSettingsChange?.(payload);
  }, [onSettingsChange]);

  const handleSaveModel = useCallback(async (draft: AgentSettingsDraft) => {
    if (!settings) return;
    const update: SettingsUpdate = {};
    if (draft.modelPreset !== null) update.modelPreset = draft.modelPreset;
    if (draft.modelPreset === "default") {
      if (draft.model) update.model = draft.model;
      if (draft.provider) update.provider = draft.provider;
    }
    const visionModel = draft.visionModel.trim();
    if (visionModel !== (settings.agent.vision_model ?? "")) update.visionModel = visionModel;
    const visionProvider = draft.visionProvider.trim();
    if (visionProvider !== (settings.agent.vision_provider ?? "")) update.visionProvider = visionProvider;
    const maxTokens = Number(draft.maxTokens);
    if (!Number.isNaN(maxTokens) && maxTokens >= 1) update.maxTokens = maxTokens;
    const contextWindowTokens = Number(draft.contextWindowTokens);
    if (!Number.isNaN(contextWindowTokens) && contextWindowTokens >= 4096) update.contextWindowTokens = contextWindowTokens;
    const maxMessages = Number(draft.maxMessages);
    if (!Number.isNaN(maxMessages) && maxMessages >= 0) update.maxMessages = maxMessages;
    update.reasoningEffort = draft.reasoningEffort;
    const payload = await updateSettings(token, update, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate, settings]);

  const handleSaveProvider = useCallback(async (providerName: string, form: ProviderForm) => {
    const rawApiType = form.apiType || undefined;
    const apiType =
      rawApiType === "auto" || rawApiType === "chat_completions" || rawApiType === "responses"
        ? rawApiType
        : undefined;
    const update: ProviderSettingsUpdate = {
      provider: providerName,
      apiKey: form.apiKey || undefined,
      apiBase: form.apiBase || undefined,
      apiType,
    };
    const payload = await updateProviderSettings(token, update, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  const handleCreateModelConfiguration = useCallback(async (draft: ModelConfigurationDraft) => {
    const payload = await createModelConfiguration(token, draft, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  const handleSaveWebSearch = useCallback(async (update: WebSearchSettingsUpdate) => {
    const payload = await updateWebSearchSettings(token, update, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  const handleSaveImageGeneration = useCallback(async (update: ImageGenerationSettingsUpdate) => {
    const payload = await updateImageGenerationSettings(token, update, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  const handleSaveTha = useCallback(async (update: ThaSettingsUpdate) => {
    const payload = await updateThaSettings(token, update, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  const handleSavePsb = useCallback(async (update: PsbSettingsUpdate) => {
    const payload = await updateDeskPetPsbSettings(token, update, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  const handleRefreshSettings = useCallback(async () => {
    const payload = await fetchSettings(token, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  const handleSaveRuntime = useCallback(async (update: SettingsUpdate) => {
    const payload = await updateSettings(token, update, apiBase);
    handleSettingsUpdate(payload);
  }, [token, apiBase, handleSettingsUpdate]);

  // -----------------------------------------------------------------------
  // CLI App actions
  // -----------------------------------------------------------------------

  const handleCliAction = useCallback(async (
    action: "install" | "update" | "uninstall" | "test",
    name: string,
  ) => {
    const data = await runCliAppAction(token, action, name, apiBase);
    setCliApps(data);
  }, [token, apiBase]);

  // -----------------------------------------------------------------------
  // MCP Preset actions
  // -----------------------------------------------------------------------

  const handleMcpAction = useCallback(async (
    action: "enable" | "remove" | "test",
    name: string,
    values: Record<string, string> = {},
  ) => {
    const data = await runMcpPresetAction(token, action, name, values, apiBase);
    setMcpPresets(data);
  }, [token, apiBase]);

  const handleMcpToolsChange = useCallback(async (name: string, enabledTools: string[]) => {
    const data = await updateMcpServerTools(token, name, enabledTools, apiBase);
    setMcpPresets(data);
  }, [token, apiBase]);

  const handleSaveCustomMcp = useCallback(async (form: CustomMcpForm) => {
    const values: Record<string, string> = {
      name: form.name,
      transport: form.transport,
      command: form.command,
      args: form.args,
      url: form.url,
      env: form.env,
      headers: form.headers,
      tool_timeout: form.toolTimeout,
    };
    const data = await saveCustomMcpServer(token, values, apiBase);
    setMcpPresets(data);
  }, [token, apiBase]);

  const handleImportMcpConfig = useCallback(async (config: string) => {
    const data = await importMcpConfig(token, config, apiBase);
    setMcpPresets(data);
  }, [token, apiBase]);

  // -----------------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------------

  const requiresRestart = settings?.requires_restart ?? false;
  const mcpRequiresRestart = mcpPresets?.requires_restart ?? false;
  const imageProviderRestartPending =
    (settings?.restart_required_sections ?? []).includes("image");

  const handleSelectSection = useCallback((section: SettingsSectionKey) => {
    setActiveSection(section);
  }, []);

  // -----------------------------------------------------------------------
  // Section router helper
  // -----------------------------------------------------------------------

  function renderSection() {
    if (!settings) return null;

    switch (activeSection) {
      case "overview":
        return (
          <OverviewSection
            settings={settings}
            requiresRestart={requiresRestart}
            onRestart={handleRestart}
            isRestarting={isRestarting}
            onSelectSection={handleSelectSection}
            showBrandLogos={showBrandLogos}
            cliApps={cliApps}
            mcpPresets={mcpPresets}
          />
        );
      case "appearance":
        return (
          <AppearanceSection
            theme={theme}
            onThemeChange={onThemeChange}
            localPrefs={localPrefs}
            onLocalPrefsChange={setLocalPrefs}
          />
        );
      case "models":
        return (
          <ModelsSection
            settings={settings}
            showBrandLogos={showBrandLogos}
            imageProviderRestartPending={imageProviderRestartPending}
            onRestart={handleRestart}
            isRestarting={isRestarting}
            onSettingsUpdate={handleSettingsUpdate}
            onSaveModel={handleSaveModel}
            onSaveProvider={handleSaveProvider}
            onCreateModelConfiguration={handleCreateModelConfiguration}
          />
        );
      case "image":
        return (
          <ImageSection
            settings={settings}
            showBrandLogos={showBrandLogos}
            pendingRestart={imageProviderRestartPending}
            onRestart={handleRestart}
            isRestarting={isRestarting}
            onOpenProviders={() => setActiveSection("models")}
            onSave={handleSaveImageGeneration}
          />
        );
      case "web":
        return (
          <WebSection
            settings={settings}
            showBrandLogos={showBrandLogos}
            pendingRestart={requiresRestart}
            onRestart={handleRestart}
            isRestarting={isRestarting}
            onSave={handleSaveWebSearch}
          />
        );
      case "deskPet":
        return (
          <DeskPetSection
            settings={settings}
            token={token}
            apiBase={apiBase}
            onSaveTha={handleSaveTha}
            onSavePsb={handleSavePsb}
            onRefreshSettings={handleRefreshSettings}
          />
        );
      case "tts":
        return (
          <TtsSection
            settings={settings}
            token={token}
            apiBase={apiBase}
            onSaved={handleRefreshSettings}
          />
        );
      case "apps":
        return (
          <AppsSection
            cliApps={cliApps}
            mcpPresets={mcpPresets}
            cliAppsLoading={cliAppsLoading}
            mcpPresetsLoading={mcpPresetsLoading}
            pendingRestart={mcpRequiresRestart}
            onRestart={handleRestart}
            isRestarting={isRestarting}
            onCliAction={handleCliAction}
            onMcpAction={handleMcpAction}
            onMcpToolsChange={handleMcpToolsChange}
            onSaveCustomMcp={handleSaveCustomMcp}
            onImportMcpConfig={handleImportMcpConfig}
          />
        );
      case "runtime":
        return (
          <RuntimeSection
            settings={settings}
            pendingRestart={requiresRestart}
            onRestart={handleRestart}
            isRestarting={isRestarting}
            onSave={handleSaveRuntime}
          />
        );
      case "advanced":
        return <AdvancedSection settings={settings} />;
      default:
        return null;
    }
  }

  return (
    <SettingsLayout
      activeSection={activeSection}
      onSelectSection={setActiveSection}
      onBack={onBack}
      loading={activeSection !== "appearance" && settingsLoading}
      error={activeSection !== "appearance" ? settingsError : null}
    >
      {renderSection()}
    </SettingsLayout>
  );
}
