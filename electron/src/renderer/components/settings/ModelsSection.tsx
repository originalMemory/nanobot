import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ChevronDown,
  Eye,
  EyeOff,
  Hexagon,
  Loader2,
  Pencil,
  RotateCcw,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { providerBrand } from "@/lib/provider-brand";
import { cn } from "@/lib/utils";
import type { SettingsPayload } from "@/lib/types";
import {
  ModelPresetPicker,
  ProviderPicker,
  ProviderPickerIcon,
  RestartSettingsFooter,
  SettingsGroup,
  SettingsRow,
  StatusPill,
} from "./shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderApiType = "auto" | "chat_completions" | "responses";
type ProviderForm = { apiKey: string; apiBase: string; apiType: ProviderApiType };

export interface AgentSettingsDraft {
  model: string;
  provider: string;
  modelPreset: string;
  visionModel: string;
  visionProvider: string;
  maxTokens: string;
  contextWindowTokens: string;
  maxMessages: string;
}

interface ModelConfigurationDraft {
  label: string;
  provider: string;
  model: string;
}

const OPENAI_API_TYPE_VALUES: ProviderApiType[] = ["auto", "chat_completions", "responses"];

function openAiApiTypeLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
  value: ProviderApiType,
): string {
  return t(`settings.byok.apiTypeOptions.${value}`, {
    defaultValue: value === "auto" ? "Auto" : value === "chat_completions" ? "Chat Completions" : "Responses",
  });
}

const LOCAL_UNCONFIGURED_PROVIDER_ORDER = new Map(
  ["vllm", "ollama", "lm_studio", "atomic_chat", "ovms"].map((name, index) => [name, index]),
);

function providerVisibilityRank(provider: SettingsPayload["providers"][number]): number {
  const localRank = LOCAL_UNCONFIGURED_PROVIDER_ORDER.get(provider.name);
  if (localRank !== undefined) return localRank;
  if ((provider.api_key_required ?? true) === false) return 100;
  return 200;
}

function orderUnconfiguredProviders(
  providers: SettingsPayload["providers"],
): SettingsPayload["providers"] {
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => {
      const rank = providerVisibilityRank(a.provider) - providerVisibilityRank(b.provider);
      return rank || a.index - b.index;
    })
    .map(({ provider }) => provider);
}

function filterProviders(
  providers: SettingsPayload["providers"],
  query: string,
): SettingsPayload["providers"] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return providers;
  return providers.filter((p) =>
    `${p.name} ${p.label} ${p.api_base ?? ""} ${p.default_api_base ?? ""}`
      .toLowerCase()
      .includes(normalized),
  );
}

function modelPresetValue(payload: SettingsPayload): string {
  return payload.agent.model_preset || "default";
}

function defaultPreset(payload: SettingsPayload) {
  return payload.model_presets.find((p) => p.is_default) ?? null;
}

function editableDefaultProvider(payload: SettingsPayload): string {
  const base = defaultPreset(payload);
  return base?.provider ?? payload.agent.provider ?? payload.agent.resolved_provider ?? "";
}

// ---------------------------------------------------------------------------
// ProviderIcon (larger variant used in provider rows)
// ---------------------------------------------------------------------------

function ProviderIcon({
  provider,
  showBrandLogos,
}: {
  provider: string;
  showBrandLogos: boolean;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const brand = providerBrand(provider);
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider]);

  if (showBrandLogos && logoUrl) {
    return (
      <span
        className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[14px] border border-border/45 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
      >
        <img
          src={logoUrl}
          alt=""
          className="h-6 w-6 object-contain"
          onError={() => setLogoIndex((i) => i + 1)}
        />
      </span>
    );
  }
  if (showBrandLogos && brand) {
    return (
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] text-[11px] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
        style={{ backgroundColor: brand.color }}
        aria-hidden
      >
        {brand.initials}
      </span>
    );
  }
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-muted text-foreground/82 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)] dark:bg-muted/70">
      <Hexagon className="h-5 w-5" strokeWidth={2} aria-hidden />
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProviderSection container
// ---------------------------------------------------------------------------

function ProviderSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.07)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.22)]">
        {count > 0 ? (
          <div className="divide-y divide-border/45">{children}</div>
        ) : (
          <div className="rounded-[18px] border border-dashed border-border/65 bg-card/45 px-4 py-5 text-[13px] text-muted-foreground">
            {empty}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// SettingsFooter (simple, no restart)
// ---------------------------------------------------------------------------

function SettingsFooter({
  dirty,
  saving,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="text-[13px] text-muted-foreground">
        {dirty && (
          <span className="inline-flex items-center gap-2 font-medium text-blue-600 dark:text-blue-300">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" aria-hidden />
            <span>{t("settings.status.unsaved")}</span>
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!dirty || saving}
          className="rounded-full"
        >
          {saving ? t("settings.actions.saving") : t("settings.actions.save")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NewModelConfigurationDialog
// ---------------------------------------------------------------------------

function NewModelConfigurationDialog({
  open,
  draft,
  providers,
  saving,
  showProviderLogos,
  onOpenChange,
  onChangeDraft,
  onSave,
}: {
  open: boolean;
  draft: ModelConfigurationDraft;
  providers: Array<{ name: string; label: string }>;
  saving: boolean;
  showProviderLogos: boolean;
  onOpenChange: (open: boolean) => void;
  onChangeDraft: (draft: ModelConfigurationDraft) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const canSave = draft.label.trim() && draft.provider.trim() && draft.model.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{tx("settings.models.newConfiguration", "New model configuration")}</DialogTitle>
          <DialogDescription>
            {tx("settings.models.newConfigurationHelp", "Save a named model + provider combo as a preset.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">
              {tx("settings.models.configurationName", "Name")}
            </span>
            <Input
              value={draft.label}
              onChange={(e) => onChangeDraft({ ...draft, label: e.target.value })}
              placeholder={tx("settings.models.configurationNamePlaceholder", "e.g. Fast Claude")}
              className="h-9 rounded-full text-[13px]"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">
              {t("settings.rows.provider")}
            </span>
            <ProviderPicker
              providers={providers}
              value={draft.provider}
              emptyLabel={t("settings.byok.noConfiguredProviders")}
              showProviderLogos={showProviderLogos}
              onChange={(provider) => onChangeDraft({ ...draft, provider })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">
              {t("settings.rows.model")}
            </span>
            <Input
              value={draft.model}
              onChange={(e) => onChangeDraft({ ...draft, model: e.target.value })}
              placeholder={tx("settings.models.modelPlaceholder", "e.g. claude-opus-4-5")}
              className="h-9 rounded-full text-[13px]"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="rounded-full">
            {t("settings.actions.cancel")}
          </Button>
          <Button
            onClick={onSave}
            disabled={!canSave || saving}
            className="rounded-full"
          >
            {saving ? t("settings.actions.saving") : t("settings.actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ModelsSection (Models + Providers combined)
// ---------------------------------------------------------------------------

interface ModelsSectionProps {
  settings: SettingsPayload;
  showBrandLogos: boolean;
  imageProviderRestartPending: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onSettingsUpdate: (payload: SettingsPayload) => void;
  onSaveModel: (draft: AgentSettingsDraft) => Promise<void>;
  onSaveProvider: (providerName: string, form: ProviderForm) => Promise<void>;
  onCreateModelConfiguration: (draft: ModelConfigurationDraft) => Promise<void>;
}

export function ModelsSection({
  settings,
  showBrandLogos,
  imageProviderRestartPending,
  onRestart,
  isRestarting,
  onSaveModel,
  onSaveProvider,
  onCreateModelConfiguration,
}: ModelsSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  // Agent form state
  const [form, setForm] = useState<AgentSettingsDraft>({
    model: defaultPreset(settings)?.model ?? settings.agent.model,
    provider: editableDefaultProvider(settings),
    modelPreset: modelPresetValue(settings),
    visionModel: settings.agent.vision_model ?? "",
    visionProvider: settings.agent.vision_provider ?? "",
    maxTokens: String(settings.agent.max_tokens),
    contextWindowTokens: String(settings.agent.context_window_tokens),
    maxMessages: String(settings.agent.max_messages ?? 120),
  });
  const [saving, setSaving] = useState(false);

  // Model configuration dialog
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<ModelConfigurationDraft>({
    label: "",
    provider: "",
    model: "",
  });
  const [configSaving, setConfigSaving] = useState(false);

  // Provider state
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [providerForms, setProviderForms] = useState<Record<string, ProviderForm>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [editingKeys, setEditingKeys] = useState<Record<string, boolean>>({});
  const [providerSaving, setProviderSaving] = useState<string | null>(null);

  useEffect(() => {
    setProviderForms((prev) => {
      const next = { ...prev };
      for (const p of settings.providers) {
        next[p.name] = {
          apiKey: next[p.name]?.apiKey ?? "",
          apiBase: next[p.name]?.apiBase ?? p.api_base ?? p.default_api_base ?? "",
          apiType: next[p.name]?.apiType ?? p.api_type ?? "auto",
        };
      }
      return next;
    });
  }, [settings]);

  const modelDirty = useMemo(() => {
    const preset = modelPresetValue(settings);
    const base = defaultPreset(settings);
    const visionModelDirty = form.visionModel !== (settings.agent.vision_model ?? "");
    const visionProviderDirty = form.visionProvider !== (settings.agent.vision_provider ?? "");
    const maxTokensDirty = Number(form.maxTokens) !== settings.agent.max_tokens;
    const contextWindowTokensDirty = Number(form.contextWindowTokens) !== settings.agent.context_window_tokens;
    const maxMessagesDirty = Number(form.maxMessages) !== (settings.agent.max_messages ?? 120);
    return (
      form.modelPreset !== preset ||
      (form.modelPreset === "default" &&
        (form.model !== (base?.model ?? settings.agent.model) ||
          form.provider !== editableDefaultProvider(settings))) ||
      visionModelDirty ||
      visionProviderDirty ||
      maxTokensDirty ||
      contextWindowTokensDirty ||
      maxMessagesDirty
    );
  }, [form, settings]);

  const configuredProviders = settings.providers.filter((p) => p.configured);
  const unconfiguredProviders = useMemo(
    () => orderUnconfiguredProviders(settings.providers.filter((p) => !p.configured)),
    [settings.providers],
  );

  const configuredModelProviderOptions = useMemo(
    () => configuredProviders.map((p) => ({ name: p.name, label: p.label })),
    [configuredProviders],
  );

  const showAutoProvider = defaultPreset(settings)?.provider === "auto" || form.provider === "auto";
  const providerOptions = showAutoProvider
    ? [{ name: "auto", label: tx("settings.values.auto", "Auto") }, ...configuredProviders]
    : configuredProviders;
  const providerValue = providerOptions.some((p) => p.name === form.provider) ? form.provider : "";

  const filteredConfigured = filterProviders(configuredProviders, providerQuery);
  const filteredUnconfigured = filterProviders(unconfiguredProviders, providerQuery);

  const handleSaveModel = async () => {
    if (!modelDirty || saving) return;
    setSaving(true);
    try {
      await onSaveModel(form);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenConfigDialog = () => {
    const currentProvider = settings.agent.provider;
    const provider =
      configuredModelProviderOptions.find((o) => o.name === currentProvider)?.name ??
      configuredModelProviderOptions[0]?.name ??
      "";
    setConfigDraft({ label: "", provider, model: "" });
    setConfigOpen(true);
  };

  const handleCreateConfig = async () => {
    if (configSaving) return;
    const label = configDraft.label.trim();
    const provider = configDraft.provider.trim();
    const model = configDraft.model.trim();
    if (!label || !provider || !model) return;
    setConfigSaving(true);
    try {
      await onCreateModelConfiguration(configDraft);
      setConfigOpen(false);
    } finally {
      setConfigSaving(false);
    }
  };

  const resetProviderDraft = useCallback(
    (name: string) => {
      const provider = settings.providers.find((p) => p.name === name);
      if (!provider) return;
      setProviderForms((prev) => ({
        ...prev,
        [name]: {
          apiKey: "",
          apiBase: provider.api_base ?? provider.default_api_base ?? "",
          apiType: provider.api_type ?? "auto",
        },
      }));
      setVisibleKeys((prev) => ({ ...prev, [name]: false }));
      setEditingKeys((prev) => ({ ...prev, [name]: false }));
    },
    [settings],
  );

  const handleToggleProvider = useCallback(
    (name: string) => {
      if (expandedProvider) resetProviderDraft(expandedProvider);
      setExpandedProvider(expandedProvider === name ? null : name);
    },
    [expandedProvider, resetProviderDraft],
  );

  const handleSaveProvider = async (name: string) => {
    if (providerSaving) return;
    const form = providerForms[name] ?? { apiKey: "", apiBase: "", apiType: "auto" as const };
    setProviderSaving(name);
    try {
      await onSaveProvider(name, form);
      setProviderForms((prev) => ({
        ...prev,
        [name]: { apiKey: "", apiBase: form.apiBase.trim(), apiType: form.apiType },
      }));
      setVisibleKeys((prev) => ({ ...prev, [name]: false }));
      setEditingKeys((prev) => ({ ...prev, [name]: false }));
    } finally {
      setProviderSaving(null);
    }
  };

  const renderProviderRow = (provider: SettingsPayload["providers"][number]) => {
    const expanded = expandedProvider === provider.name;
    const pForm = providerForms[provider.name] ?? {
      apiKey: "",
      apiBase: provider.api_base ?? provider.default_api_base ?? "",
      apiType: (provider.api_type ?? "auto") as ProviderApiType,
    };
    const isSaving = providerSaving === provider.name;
    const keyVisible = !!visibleKeys[provider.name];
    const editingKey = !provider.configured || !!editingKeys[provider.name];
    const apiKeyRequired = provider.api_key_required ?? true;
    const apiKey = pForm.apiKey.trim();
    const apiBase = pForm.apiBase.trim();
    const missingRequiredApiKey = apiKeyRequired && !provider.configured && !apiKey;
    const missingOptionalCredential = !apiKeyRequired && !provider.configured && !apiKey && !apiBase;

    return (
      <div key={provider.name} className="divide-y divide-border/45">
        <button
          type="button"
          onClick={() => handleToggleProvider(provider.name)}
          className="flex min-h-[70px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5"
        >
          <span className="flex min-w-0 items-center gap-3">
            <ProviderIcon provider={provider.name} showBrandLogos={showBrandLogos} />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold leading-5 text-foreground">
                {provider.label}
              </span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {provider.api_base || provider.default_api_base || provider.name}
              </span>
            </span>
          </span>
          <StatusPill tone={provider.configured ? "success" : "neutral"}>
            {provider.configured ? t("settings.byok.configured") : t("settings.byok.notConfigured")}
          </StatusPill>
        </button>

        {expanded ? (
          <div className="space-y-3 bg-muted/18 px-4 py-4 sm:px-5">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiKey")}
              </span>
              <div className="relative">
                {editingKey ? (
                  <>
                    <Input
                      type={keyVisible ? "text" : "password"}
                      value={pForm.apiKey}
                      onChange={(e) =>
                        setProviderForms((prev) => ({
                          ...prev,
                          [provider.name]: { ...prev[provider.name], apiKey: e.target.value },
                        }))
                      }
                      placeholder={
                        provider.configured
                          ? t("settings.byok.apiKeyConfiguredPlaceholder")
                          : t("settings.byok.apiKeyPlaceholder")
                      }
                      className="h-9 rounded-full pr-11 text-[13px]"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setVisibleKeys((prev) => ({ ...prev, [provider.name]: !keyVisible }))}
                      aria-label={keyVisible ? t("settings.byok.hideApiKey") : t("settings.byok.showApiKey")}
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {keyVisible ? (
                        <EyeOff className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Eye className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex h-9 items-center rounded-full border border-input bg-background px-3 pr-11 text-[13px] text-muted-foreground">
                      {provider.api_key_hint ?? t("settings.byok.configuredKeyHint")}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setEditingKeys((prev) => ({ ...prev, [provider.name]: true }))
                      }
                      aria-label={t("settings.actions.edit")}
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiBase")}
              </span>
              <Input
                value={pForm.apiBase}
                onChange={(e) =>
                  setProviderForms((prev) => ({
                    ...prev,
                    [provider.name]: { ...prev[provider.name], apiBase: e.target.value },
                  }))
                }
                placeholder={provider.default_api_base ?? t("settings.byok.apiBasePlaceholder")}
                className="h-9 rounded-full text-[13px]"
              />
            </label>
            {provider.name === "openai" ? (
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">
                  {tx("settings.byok.apiType", "API type")}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 w-full justify-between rounded-full px-3 text-[13px]"
                    >
                      <span>
                        {openAiApiTypeLabel(t, pForm.apiType)}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[220px]">
                    {OPENAI_API_TYPE_VALUES.map((value) => (
                      <DropdownMenuItem
                        key={value}
                        onSelect={() =>
                          setProviderForms((prev) => ({
                            ...prev,
                            [provider.name]: { ...prev[provider.name], apiType: value },
                          }))
                        }
                      >
                        {openAiApiTypeLabel(t, value)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </label>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => resetProviderDraft(provider.name)}
                className="rounded-full"
              >
                {t("settings.actions.cancel")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSaveProvider(provider.name)}
                disabled={isSaving || missingRequiredApiKey || missingOptionalCredential}
                className="rounded-full"
              >
                {isSaving
                  ? t("settings.actions.saving")
                  : tx("settings.providers.saveProvider", "Save provider")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* Models */}
      <div className="space-y-7">
        <section>
          <SettingsGroup>
            <SettingsRow
              title={tx("settings.rows.currentModel", "Current model")}
              description={tx(
                "settings.help.currentModel",
                "Choose the model nanobot uses for new replies.",
              )}
            >
              <ModelPresetPicker
                presets={settings.model_presets}
                value={form.modelPreset}
                settings={settings}
                draftModel={form.model}
                draftProvider={form.provider}
                showProviderLogos={showBrandLogos}
                onChange={(modelPreset) => setForm((prev) => ({ ...prev, modelPreset }))}
                onCreateConfiguration={handleOpenConfigDialog}
              />
            </SettingsRow>
            {form.modelPreset === "default" ? (
              <>
                <SettingsRow
                  title={t("settings.rows.provider")}
                  description={t("settings.help.provider")}
                >
                  <ProviderPicker
                    providers={providerOptions}
                    value={providerValue}
                    emptyLabel={t("settings.byok.noConfiguredProviders")}
                    showProviderLogos={showBrandLogos}
                    onChange={(provider) => setForm((prev) => ({ ...prev, provider }))}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.rows.model")}
                  description={t("settings.help.model")}
                >
                  <Input
                    value={form.model}
                    onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
                    className="h-8 w-[min(280px,70vw)] rounded-full text-[13px]"
                  />
                </SettingsRow>
              </>
            ) : null}
            <SettingsRow
              title={t("settings.rows.visionModel")}
              description={t("settings.help.visionModel")}
            >
              <Input
                value={form.visionModel}
                onChange={(e) => setForm((prev) => ({ ...prev, visionModel: e.target.value }))}
                placeholder={tx("settings.models.visionModelPlaceholder", "e.g. gemini-2.5-flash")}
                className="h-8 w-[min(280px,70vw)] rounded-full text-[13px]"
              />
            </SettingsRow>
            <SettingsRow
              title={t("settings.rows.visionProvider")}
              description={t("settings.help.visionProvider")}
            >
              <ProviderPicker
                providers={[
                  { name: "", label: tx("settings.values.auto", "Auto") },
                  ...configuredProviders,
                ]}
                value={form.visionProvider}
                emptyLabel={tx("settings.values.auto", "Auto")}
                showProviderLogos={showBrandLogos}
                onChange={(visionProvider) => setForm((prev) => ({ ...prev, visionProvider }))}
              />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup>
            <SettingsRow
              title={tx("settings.rows.maxTokens", "Max Output Tokens")}
              description={tx("settings.help.maxTokens", "Maximum tokens the model generates per reply.")}
            >
              <Input
                type="number"
                min={1}
                value={form.maxTokens}
                onChange={(e) => setForm((prev) => ({ ...prev, maxTokens: e.target.value }))}
                className="h-8 w-[140px] rounded-full text-[13px]"
              />
            </SettingsRow>
            <SettingsRow
              title={tx("settings.rows.contextWindowTokens", "Context Window")}
              description={tx("settings.help.contextWindowTokens", "Total context window size of the model. Used for consolidation and truncation decisions.")}
            >
              <Input
                type="number"
                min={4096}
                value={form.contextWindowTokens}
                onChange={(e) => setForm((prev) => ({ ...prev, contextWindowTokens: e.target.value }))}
                className="h-8 w-[140px] rounded-full text-[13px]"
              />
            </SettingsRow>
            <SettingsRow
              title={tx("settings.rows.maxMessages", "Max Messages")}
              description={tx("settings.help.maxMessages", "Max number of messages replayed from history. 0 uses the default (120).")}
            >
              <Input
                type="number"
                min={0}
                value={form.maxMessages}
                onChange={(e) => setForm((prev) => ({ ...prev, maxMessages: e.target.value }))}
                className="h-8 w-[140px] rounded-full text-[13px]"
              />
            </SettingsRow>
            <SettingsFooter dirty={modelDirty} saving={saving} onSave={() => void handleSaveModel()} />
          </SettingsGroup>
        </section>
      </div>

      {/* Providers (BYOK) */}
      <div className="space-y-6">
        <p className="max-w-[42rem] text-[13px] leading-6 text-muted-foreground">
          {t("settings.byok.description")}
        </p>
        {imageProviderRestartPending && onRestart ? (
          <div className="flex min-h-[48px] items-center justify-between gap-3 border-y border-border/55 py-3">
            <p className="text-[13px] leading-5 text-muted-foreground">
              {tx(
                "settings.status.imageProviderRestart",
                "Image provider changes saved. Restart when ready.",
              )}
            </p>
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
          </div>
        ) : null}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={providerQuery}
            onChange={(e) => setProviderQuery(e.target.value)}
            placeholder={tx("settings.providers.searchPlaceholder", "Search providers")}
            className="h-10 rounded-full pl-9 text-[13px]"
          />
        </div>
        <ProviderSection
          title={t("settings.byok.configuredSection")}
          count={filteredConfigured.length}
          empty={t("settings.byok.noConfiguredProviders")}
        >
          {filteredConfigured.map(renderProviderRow)}
        </ProviderSection>
        <ProviderSection
          title={t("settings.byok.notConfiguredSection")}
          count={filteredUnconfigured.length}
          empty={tx("settings.providers.noMatches", "No providers match this search.")}
        >
          {filteredUnconfigured.map(renderProviderRow)}
        </ProviderSection>
        <p className="px-1 text-[11.5px] leading-5 text-muted-foreground/75">
          {t("settings.legal.thirdPartyBrands", {
            defaultValue:
              "Product names, logos, and brands are property of their respective owners. Use is for identification only and does not imply endorsement.",
          })}
        </p>
      </div>

      <NewModelConfigurationDialog
        open={configOpen}
        draft={configDraft}
        providers={configuredModelProviderOptions}
        saving={configSaving}
        showProviderLogos={showBrandLogos}
        onOpenChange={setConfigOpen}
        onChangeDraft={setConfigDraft}
        onSave={() => void handleCreateConfig()}
      />
    </div>
  );
}
