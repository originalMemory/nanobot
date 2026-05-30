import {
  forwardRef,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  Database,
  Loader2,
  PlayCircle,
  Plus,
  RotateCcw,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { logoFallbackUrls } from "@/lib/provider-brand";
import { cn } from "@/lib/utils";
import type { CliAppInfo, CliAppsPayload, McpPresetInfo, McpPresetsPayload } from "@/lib/types";
import { SegmentedControl, SettingsSectionTitle } from "./shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppsKindFilter = "all" | "cli" | "mcp";
type AppsCatalogItem =
  | { id: string; kind: "cli"; app: CliAppInfo }
  | { id: string; kind: "mcp"; preset: McpPresetInfo };

type CustomMcpTransport = "stdio" | "streamableHttp" | "sse";

interface CustomMcpForm {
  name: string;
  transport: CustomMcpTransport;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  toolTimeout: string;
}

const DEFAULT_CUSTOM_MCP_FORM: CustomMcpForm = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  headers: "",
  toolTimeout: "30",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appsTitle(item: AppsCatalogItem): string {
  return item.kind === "cli" ? item.app.display_name : item.preset.display_name;
}

function appsReady(item: AppsCatalogItem): boolean {
  return item.kind === "cli"
    ? item.app.installed
    : item.preset.installed && item.preset.configured;
}

function appsSearchText(item: AppsCatalogItem): string {
  if (item.kind === "cli") {
    const a = item.app;
    return [a.display_name, a.name, a.category, a.description, a.requires, a.entry_point, a.source]
      .join(" ")
      .toLowerCase();
  }
  const p = item.preset;
  return [p.display_name, p.name, p.category, p.description, p.requires, p.note, p.transport, p.source ?? ""]
    .join(" ")
    .toLowerCase();
}

function mcpPresetStatusLabel(status: string, tx: (key: string, fallback: string) => string): string {
  switch (status) {
    case "configured": return tx("settings.mcp.statusConfigured", "Configured");
    case "missing_credentials": return tx("settings.mcp.statusMissingCredentials", "Needs key");
    case "missing_dependency": return tx("settings.mcp.statusMissingDependency", "Needs dependency");
    case "coming_soon": return tx("settings.mcp.statusComingSoon", "Coming soon");
    default: return tx("settings.mcp.statusNotInstalled", "Not enabled");
  }
}

// ---------------------------------------------------------------------------
// Logos
// ---------------------------------------------------------------------------

function AppLogo({
  logoUrl: rawLogoUrl,
  displayName,
  name,
  brandColor,
}: {
  logoUrl?: string | null;
  displayName: string;
  name: string;
  brandColor?: string | null;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const bg = brandColor || "hsl(var(--muted))";
  const logoUrls = useMemo(() => logoFallbackUrls(rawLogoUrl), [rawLogoUrl]);
  const logoSrc = logoUrls[logoIndex];
  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || name.slice(0, 2).toUpperCase();

  useEffect(() => setLogoIndex(0), [rawLogoUrl]);

  if (logoSrc) {
    return (
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] border border-border/45 bg-background"
        style={{ boxShadow: `inset 0 0 0 1px ${brandColor ?? "transparent"}22` }}
      >
        <img
          src={logoSrc}
          alt=""
          className="h-6 w-6 object-contain"
          onError={() => setLogoIndex((i) => i + 1)}
        />
      </span>
    );
  }
  return (
    <span
      className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] text-[13px] font-semibold text-white"
      style={{ backgroundColor: bg }}
    >
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AppsActionButton
// ---------------------------------------------------------------------------

const AppsActionButton = forwardRef<
  HTMLButtonElement,
  {
    ariaLabel: string;
    busy?: boolean;
    disabled?: boolean;
    tone?: "default" | "installed" | "danger";
    onClick?: () => void;
    children: ReactNode;
  }
>(function AppsActionButton({ ariaLabel, busy, disabled, tone = "default", onClick, children }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      size="icon"
      variant="ghost"
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn(
        "h-9 w-9 rounded-full text-muted-foreground transition-colors",
        tone === "installed" && "bg-transparent hover:bg-muted/70 hover:text-foreground",
        tone === "danger" && "bg-transparent hover:bg-destructive/10 hover:text-destructive",
        tone === "default" && "bg-muted/70 hover:bg-muted hover:text-foreground",
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : children}
    </Button>
  );
});

function AppsTypeBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-[0.06em] text-muted-foreground">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// CliAppsCatalogRow
// ---------------------------------------------------------------------------

function CliAppsCatalogRow({
  app,
  actionKey,
  onAction,
}: {
  app: CliAppInfo;
  actionKey: string | null;
  onAction: (action: "install" | "update" | "uninstall" | "test", name: string) => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const installBusy = actionKey === `install:${app.name}`;
  const updateBusy = actionKey === `update:${app.name}`;
  const uninstallBusy = actionKey === `uninstall:${app.name}`;
  const testBusy = actionKey === `test:${app.name}`;
  const busy = installBusy || updateBusy || uninstallBusy || testBusy;
  const description = app.description || app.requires || app.entry_point || app.name;

  return (
    <article className="group flex min-w-0 items-center gap-3 rounded-[14px] px-3 py-3 transition-colors hover:bg-muted/45">
      <AppLogo
        logoUrl={app.logo_url}
        displayName={app.display_name}
        name={app.name}
        brandColor={app.brand_color}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="truncate text-[14px] font-semibold leading-5 text-foreground">{app.display_name}</h3>
          <AppsTypeBadge>{tx("settings.apps.cliLabel", "CLI")}</AppsTypeBadge>
        </div>
        <p className="mt-0.5 truncate text-[12.5px] leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {app.installed ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <AppsActionButton
                  ariaLabel={tx("settings.cliApps.statusInstalled", "Installed")}
                  busy={testBusy || updateBusy}
                  disabled={busy}
                  tone="installed"
                >
                  <Check className="h-4 w-4" aria-hidden />
                </AppsActionButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={busy} onClick={() => onAction("test", app.name)}>
                  <PlayCircle className="mr-2 h-3.5 w-3.5" aria-hidden />
                  {tx("settings.cliApps.test", "Test CLI")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onClick={() => onAction("update", app.name)}>
                  <RotateCcw className="mr-2 h-3.5 w-3.5" aria-hidden />
                  {tx("settings.cliApps.update", "Update CLI")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onClick={() => onAction("uninstall", app.name)}>
                  <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden />
                  {tx("settings.cliApps.uninstall", "Uninstall CLI")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : app.install_supported ? (
          <AppsActionButton
            ariaLabel={tx("settings.cliApps.install", "Install CLI")}
            busy={installBusy}
            onClick={() => onAction("install", app.name)}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </AppsActionButton>
        ) : (
          <AppsActionButton ariaLabel={tx("settings.cliApps.unavailable", "Unavailable")} disabled>
            <Plus className="h-4 w-4" aria-hidden />
          </AppsActionButton>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// McpAppsCatalogRow
// ---------------------------------------------------------------------------

function McpAppsCatalogRow({
  preset,
  values,
  actionKey,
  onFieldChange,
  onAction,
  onToolsChange,
}: {
  preset: McpPresetInfo;
  values: Record<string, string>;
  actionKey: string | null;
  onFieldChange: (name: string, field: string, value: string) => void;
  onAction: (action: "enable" | "remove" | "test", name: string, values?: Record<string, string>) => void;
  onToolsChange: (name: string, enabledTools: string[]) => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [setupOpen, setSetupOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const enableBusy = actionKey === `enable:${preset.name}`;
  const removeBusy = actionKey === `remove:${preset.name}`;
  const testBusy = actionKey === `test:${preset.name}`;
  const toolsBusy = actionKey === `tools:${preset.name}`;
  const busy = enableBusy || removeBusy || testBusy || toolsBusy;
  const missingFields = preset.required_fields.filter((f) => f.required && !f.configured);
  const hasFields = preset.required_fields.length > 0;
  const needsSetupInput = missingFields.length > 0;
  const readyInstalled = preset.installed && preset.configured;
  const canEnable =
    preset.install_supported &&
    (missingFields.length === 0 || missingFields.every((f) => Boolean(values[f.name]?.trim())));
  const toolNames = preset.tool_names ?? [];
  const enabledTools = preset.enabled_tools ?? ["*"];
  const allowAllTools = enabledTools.includes("*");
  const enabledSet = new Set(allowAllTools ? toolNames : enabledTools);
  const description = preset.description || preset.note || preset.requires || preset.name;
  const statusLabel = mcpPresetStatusLabel(preset.status, tx);

  useEffect(() => {
    if (preset.configured || !preset.install_supported) setSetupOpen(false);
  }, [preset.configured, preset.install_supported]);

  const enableOrOpenSetup = () => {
    if (needsSetupInput || (preset.installed && !preset.configured && hasFields)) {
      setSetupOpen(true);
      return;
    }
    onAction("enable", preset.name, values);
  };

  const setTools = (next: string[]) => onToolsChange(preset.name, next);
  const toggleTool = (toolName: string) => {
    const next = new Set(allowAllTools ? toolNames : enabledTools);
    if (next.has(toolName)) next.delete(toolName);
    else next.add(toolName);
    const nextArr = Array.from(next);
    setTools(nextArr.length === toolNames.length ? ["*"] : nextArr);
  };

  return (
    <article className="rounded-[14px] transition-colors hover:bg-muted/45">
      <div className="group flex min-w-0 items-center gap-3 px-3 py-3">
        <AppLogo
          logoUrl={preset.logo_url}
          displayName={preset.display_name}
          name={preset.name}
          brandColor={preset.brand_color}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="truncate text-[14px] font-semibold leading-5 text-foreground">{preset.display_name}</h3>
            <AppsTypeBadge>{tx("settings.apps.mcpLabel", "MCP")}</AppsTypeBadge>
          </div>
          <p className="mt-0.5 truncate text-[12.5px] leading-5 text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {readyInstalled ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <AppsActionButton ariaLabel={statusLabel} busy={testBusy || toolsBusy} disabled={busy} tone="installed">
                    <Check className="h-4 w-4" aria-hidden />
                  </AppsActionButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={busy} onClick={() => onAction("test", preset.name)}>
                    <PlayCircle className="mr-2 h-3.5 w-3.5" aria-hidden />
                    {tx("settings.mcp.test", "Test")}
                  </DropdownMenuItem>
                  {toolNames.length ? (
                    <DropdownMenuItem disabled={busy} onClick={() => setToolsOpen((o) => !o)}>
                      <SlidersHorizontal className="mr-2 h-3.5 w-3.5" aria-hidden />
                      {tx("settings.mcp.toolScope", "Tools")}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem disabled={busy} onClick={() => onAction("remove", preset.name)}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden />
                    {tx("settings.mcp.remove", "Remove")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <AppsActionButton
                ariaLabel={tx("settings.mcp.remove", "Remove")}
                busy={removeBusy}
                disabled={busy && !removeBusy}
                tone="danger"
                onClick={() => onAction("remove", preset.name)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </AppsActionButton>
            </>
          ) : preset.installed && !preset.configured ? (
            <AppsActionButton
              ariaLabel={hasFields ? tx("settings.mcp.configure", "Configure") : tx("settings.mcp.enable", "Enable")}
              busy={enableBusy}
              onClick={() => { if (hasFields) setSetupOpen(true); else onAction("enable", preset.name, values); }}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </AppsActionButton>
          ) : preset.install_supported ? (
            <AppsActionButton
              ariaLabel={needsSetupInput ? tx("settings.mcp.setup", "Set up") : tx("settings.mcp.enable", "Enable")}
              busy={enableBusy}
              onClick={enableOrOpenSetup}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </AppsActionButton>
          ) : (
            <AppsActionButton ariaLabel={tx("settings.mcp.comingSoon", "Coming soon")} disabled>
              <Plus className="h-4 w-4" aria-hidden />
            </AppsActionButton>
          )}
        </div>
      </div>

      {setupOpen && preset.install_supported && hasFields ? (
        <div className="mx-3 mb-3 rounded-[14px] border border-border/45 bg-card/85 p-3 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-semibold text-foreground">
                {tx("settings.mcp.connectTitle", "Connect {{name}}").replace("{{name}}", preset.display_name)}
              </div>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                {tx("settings.mcp.connectHint", "Add the key from your account settings.")}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSetupOpen(false)}
              className="h-7 rounded-full px-2.5 text-[11.5px] font-semibold text-muted-foreground"
            >
              {tx("actions.cancel", "Cancel")}
            </Button>
          </div>
          <div className="mt-3 grid gap-2">
            {preset.required_fields.map((field) => (
              <label key={field.name} className="min-w-0">
                <span className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                  {field.label}
                  {field.configured ? (
                    <span className="ml-1 font-normal text-emerald-600 dark:text-emerald-300">
                      {tx("settings.mcp.configured", "configured")}
                    </span>
                  ) : null}
                </span>
                <Input
                  type={field.secret ? "password" : "text"}
                  value={values[field.name] ?? ""}
                  onChange={(e) => onFieldChange(preset.name, field.name, e.target.value)}
                  placeholder={field.configured ? tx("settings.mcp.keepExisting", "Leave blank to keep existing") : field.placeholder}
                  className="h-9 rounded-full bg-background/80 text-[12.5px]"
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={busy || !canEnable}
              onClick={() => onAction("enable", preset.name, values)}
              className="h-8 rounded-full px-3 text-[12px] font-semibold"
            >
              {enableBusy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              )}
              {preset.installed
                ? tx("settings.mcp.updateSetup", "Update setup")
                : tx("settings.mcp.saveAndEnable", "Save and enable")}
            </Button>
          </div>
        </div>
      ) : null}

      {toolsOpen && readyInstalled && toolNames.length ? (
        <div className="mx-3 mb-3 rounded-[14px] border border-border/45 bg-card/85 p-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11.5px] font-medium text-muted-foreground">
              {tx("settings.mcp.toolScope", "Tools")}
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant={allowAllTools ? "default" : "outline"}
                disabled={toolsBusy}
                onClick={() => setTools(["*"])}
                className="h-7 rounded-full px-2.5 text-[11.5px] font-semibold"
              >
                {tx("settings.mcp.allTools", "All")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={!allowAllTools && enabledSet.size === 0 ? "default" : "outline"}
                disabled={toolsBusy}
                onClick={() => setTools([])}
                className="h-7 rounded-full px-2.5 text-[11.5px] font-semibold"
              >
                {tx("settings.mcp.noTools", "None")}
              </Button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {toolNames.map((toolName) => {
              const selected = enabledSet.has(toolName);
              return (
                <button
                  key={toolName}
                  type="button"
                  disabled={toolsBusy}
                  onClick={() => toggleTool(toolName)}
                  className={cn(
                    "max-w-full rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    selected
                      ? "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                      : "border-border/55 bg-muted/30 text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <span className="block max-w-[220px] truncate">{toolName}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// McpCustomServerPanel
// ---------------------------------------------------------------------------

function McpCustomServerPanel({
  form,
  configImport,
  actionKey,
  onFormChange,
  onConfigImportChange,
  onSave,
  onImportConfig,
}: {
  form: CustomMcpForm;
  configImport: string;
  actionKey: string | null;
  onFormChange: (form: CustomMcpForm) => void;
  onConfigImportChange: (value: string) => void;
  onSave: () => void;
  onImportConfig: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [activeMode, setActiveMode] = useState<"custom" | "import" | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const customBusy = actionKey?.startsWith("custom:") ?? false;
  const importBusy = actionKey === "import";
  const remote = form.transport !== "stdio";
  const canSave =
    Boolean(form.name.trim()) &&
    (remote ? Boolean(form.url.trim()) : Boolean(form.command.trim()));
  const update = <K extends keyof CustomMcpForm>(key: K, value: CustomMcpForm[K]) => {
    onFormChange({ ...form, [key]: value });
  };
  const transports: Array<{ value: CustomMcpTransport; label: string }> = [
    { value: "stdio", label: "stdio" },
    { value: "streamableHttp", label: "HTTP" },
    { value: "sse", label: "SSE" },
  ];

  return (
    <section className="overflow-hidden rounded-[16px] border border-border/45 bg-card/72 shadow-[0_10px_30px_rgba(15,23,42,0.045)]">
      <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-muted text-muted-foreground">
            <Server className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold leading-5 text-foreground">
              {tx("settings.mcp.moreOptions", "More MCP options")}
            </h3>
            <p className="truncate text-[12px] text-muted-foreground">
              {tx("settings.mcp.moreOptionsSubtitle", "Add a custom server or import mcp.json.")}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
          <Button
            type="button"
            size="sm"
            variant={activeMode === "custom" ? "default" : "outline"}
            onClick={() => setActiveMode((m) => (m === "custom" ? null : "custom"))}
            className="h-8 rounded-full px-3 text-[12px] font-semibold"
          >
            <Server className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {tx("settings.mcp.customAction", "Custom")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeMode === "import" ? "default" : "outline"}
            onClick={() => setActiveMode((m) => (m === "import" ? null : "import"))}
            className="h-8 rounded-full px-3 text-[12px] font-semibold"
          >
            <Database className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {tx("settings.mcp.importAction", "Import")}
          </Button>
        </div>
      </div>

      {activeMode === "custom" ? (
        <div className="border-t border-border/35 bg-muted/18 px-3 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-[11.5px] font-medium text-muted-foreground">
                {tx("settings.mcp.serverName", "Server name")}
              </span>
              <Input
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="docs"
                className="h-9 rounded-full bg-background/80 text-[12.5px]"
              />
            </label>
            <div className="min-w-[228px]">
              <span className="mb-1.5 block text-[11.5px] font-medium text-muted-foreground">
                {tx("settings.mcp.transport", "Transport")}
              </span>
              <SegmentedControl
                value={form.transport}
                options={transports}
                onChange={(v) => update("transport", v as CustomMcpTransport)}
              />
            </div>
            {remote ? (
              <label className="min-w-0 flex-[1.4]">
                <span className="mb-1.5 block text-[11.5px] font-medium text-muted-foreground">
                  {tx("settings.mcp.serverUrl", "URL")}
                </span>
                <Input
                  value={form.url}
                  onChange={(e) => update("url", e.target.value)}
                  placeholder={form.transport === "sse" ? "https://example.com/sse" : "https://example.com/mcp"}
                  className="h-9 rounded-full bg-background/80 text-[12.5px]"
                />
              </label>
            ) : (
              <label className="min-w-0 flex-[1.4]">
                <span className="mb-1.5 block text-[11.5px] font-medium text-muted-foreground">
                  {tx("settings.mcp.command", "Command")}
                </span>
                <Input
                  value={form.command}
                  onChange={(e) => update("command", e.target.value)}
                  placeholder="npx"
                  className="h-9 rounded-full bg-background/80 text-[12.5px]"
                />
              </label>
            )}
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={!canSave || customBusy}
              className="h-9 shrink-0 rounded-full px-4 text-[12.5px] font-semibold"
            >
              {customBusy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              )}
              {tx("settings.mcp.saveCustom", "Save MCP")}
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="mt-2 h-8 rounded-full px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn("mr-1.5 h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-180")}
              aria-hidden
            />
            {advancedOpen
              ? tx("settings.mcp.hideAdvanced", "Hide advanced")
              : tx("settings.mcp.advancedOptions", "Advanced options")}
          </Button>
          {advancedOpen ? (
            <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_180px]">
              {!remote ? (
                <label className="min-w-0">
                  <span className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    {tx("settings.mcp.args", "Args JSON")}
                  </span>
                  <Textarea
                    value={form.args}
                    onChange={(e) => update("args", e.target.value)}
                    placeholder={'["-y", "docs-mcp"]'}
                    className="min-h-[68px] resize-y rounded-[12px] bg-background/80 font-mono text-[12px]"
                  />
                </label>
              ) : (
                <label className="min-w-0">
                  <span className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    {tx("settings.mcp.headers", "Headers JSON")}
                  </span>
                  <Textarea
                    value={form.headers}
                    onChange={(e) => update("headers", e.target.value)}
                    placeholder={'{"Authorization":"Bearer ..."}'}
                    className="min-h-[68px] resize-y rounded-[12px] bg-background/80 font-mono text-[12px]"
                  />
                </label>
              )}
              <label className="min-w-0">
                <span className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                  {tx("settings.mcp.env", "Env JSON")}
                </span>
                <Textarea
                  value={form.env}
                  onChange={(e) => update("env", e.target.value)}
                  placeholder={'{"API_KEY":"..."}'}
                  className="min-h-[68px] resize-y rounded-[12px] bg-background/80 font-mono text-[12px]"
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                  {tx("settings.mcp.timeout", "Tool timeout")}
                </span>
                <Input
                  value={form.toolTimeout}
                  onChange={(e) => update("toolTimeout", e.target.value)}
                  inputMode="numeric"
                  className="h-9 rounded-full bg-background/80 text-[12.5px]"
                />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeMode === "import" ? (
        <div className="border-t border-border/35 bg-muted/18 px-3 py-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-[11.5px] font-medium text-muted-foreground">
                {tx("settings.mcp.configImport", "Import mcp.json")}
              </span>
              <Textarea
                value={configImport}
                onChange={(e) => onConfigImportChange(e.target.value)}
                placeholder={'{"mcpServers":{"docs":{"command":"npx","args":["-y","docs-mcp"]}}}'}
                className="min-h-[84px] resize-y rounded-[12px] bg-background/80 font-mono text-[12px]"
              />
            </label>
            <Button
              type="button"
              size="sm"
              onClick={onImportConfig}
              disabled={!configImport.trim() || importBusy}
              className="h-9 shrink-0 rounded-full px-4 text-[12.5px] font-semibold"
            >
              {importBusy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Database className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              )}
              {tx("settings.mcp.importConfig", "Import")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// AppsSectionProps + AppsSectionState (lifted for external callbacks)
// ---------------------------------------------------------------------------

interface AppsSectionProps {
  cliApps: CliAppsPayload | null;
  mcpPresets: McpPresetsPayload | null;
  cliAppsLoading: boolean;
  mcpPresetsLoading: boolean;
  pendingRestart: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onCliAction: (
    action: "install" | "update" | "uninstall" | "test",
    name: string,
  ) => Promise<void>;
  onMcpAction: (
    action: "enable" | "remove" | "test",
    name: string,
    values?: Record<string, string>,
  ) => Promise<void>;
  onMcpToolsChange: (name: string, enabledTools: string[]) => Promise<void>;
  onSaveCustomMcp: (form: CustomMcpForm) => Promise<void>;
  onImportMcpConfig: (config: string) => Promise<void>;
}

export function AppsSection({
  cliApps,
  mcpPresets,
  cliAppsLoading,
  mcpPresetsLoading,
  pendingRestart,
  onRestart,
  isRestarting,
  onCliAction,
  onMcpAction,
  onMcpToolsChange,
  onSaveCustomMcp,
  onImportMcpConfig,
}: AppsSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AppsKindFilter>("all");
  const [cliActionKey, setCliActionKey] = useState<string | null>(null);
  const [mcpActionKey, setMcpActionKey] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusIsError, setStatusIsError] = useState(false);
  const [mcpFieldValues, setMcpFieldValues] = useState<Record<string, Record<string, string>>>({});
  const [customMcpForm, setCustomMcpForm] = useState<CustomMcpForm>(DEFAULT_CUSTOM_MCP_FORM);
  const [configImport, setConfigImport] = useState("");

  const filterOptions = [
    { value: "all", label: tx("settings.apps.filterAll", "All") },
    { value: "cli", label: tx("settings.apps.filterCli", "App CLIs") },
    { value: "mcp", label: tx("settings.apps.filterMcp", "MCP services") },
  ];

  const normalizedQuery = query.trim().toLowerCase();
  const items: AppsCatalogItem[] = useMemo(() => {
    const all: AppsCatalogItem[] = [
      ...(cliApps?.apps ?? []).map((app) => ({ id: `cli:${app.name}`, kind: "cli" as const, app })),
      ...(mcpPresets?.presets ?? []).map((preset) => ({ id: `mcp:${preset.name}`, kind: "mcp" as const, preset })),
    ];
    return all
      .filter((item) => filter === "all" || item.kind === filter)
      .filter((item) => !normalizedQuery || appsSearchText(item).includes(normalizedQuery))
      .sort((a, b) => {
        const rank = Number(!appsReady(a)) - Number(!appsReady(b));
        return rank || appsTitle(a).localeCompare(appsTitle(b));
      });
  }, [cliApps, mcpPresets, filter, normalizedQuery]);

  const loading = (cliAppsLoading || mcpPresetsLoading) && !cliApps && !mcpPresets;
  const caption = tx("settings.apps.caption", "{{cli}} CLI · {{mcp}} MCP")
    .replace("{{cli}}", String(cliApps?.installed_count ?? 0))
    .replace("{{mcp}}", String(mcpPresets?.installed_count ?? 0));

  const handleCliAction = async (
    action: "install" | "update" | "uninstall" | "test",
    name: string,
  ) => {
    const key = `${action}:${name}`;
    setCliActionKey(key);
    setStatusMessage(null);
    setStatusIsError(false);
    try {
      await onCliAction(action, name);
    } catch (err) {
      setStatusMessage((err as Error).message);
      setStatusIsError(true);
    } finally {
      setCliActionKey(null);
    }
  };

  const handleMcpAction = async (
    action: "enable" | "remove" | "test",
    name: string,
    values: Record<string, string> = {},
  ) => {
    const key = `${action}:${name}`;
    setMcpActionKey(key);
    setStatusMessage(null);
    setStatusIsError(false);
    try {
      await onMcpAction(action, name, values);
      if (action === "enable") {
        setMcpFieldValues((prev) => ({ ...prev, [name]: {} }));
      }
    } catch (err) {
      setStatusMessage((err as Error).message);
      setStatusIsError(true);
    } finally {
      setMcpActionKey(null);
    }
  };

  const handleMcpToolsChange = async (name: string, enabledTools: string[]) => {
    setMcpActionKey(`tools:${name}`);
    try {
      await onMcpToolsChange(name, enabledTools);
    } catch (err) {
      setStatusMessage((err as Error).message);
      setStatusIsError(true);
    } finally {
      setMcpActionKey(null);
    }
  };

  const handleSaveCustomMcp = async () => {
    const key = `custom:${customMcpForm.name || "new"}`;
    setMcpActionKey(key);
    setStatusMessage(null);
    setStatusIsError(false);
    try {
      await onSaveCustomMcp(customMcpForm);
      setCustomMcpForm((prev) => ({ ...DEFAULT_CUSTOM_MCP_FORM, transport: prev.transport }));
    } catch (err) {
      setStatusMessage((err as Error).message);
      setStatusIsError(true);
    } finally {
      setMcpActionKey(null);
    }
  };

  const handleImportConfig = async () => {
    setMcpActionKey("import");
    setStatusMessage(null);
    setStatusIsError(false);
    try {
      await onImportMcpConfig(configImport);
      setConfigImport("");
    } catch (err) {
      setStatusMessage((err as Error).message);
      setStatusIsError(true);
    } finally {
      setMcpActionKey(null);
    }
  };

  return (
    <div className="space-y-7">
      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-[680px] text-[13px] leading-5 text-muted-foreground">
            {tx(
              "settings.apps.description",
              "Add local app adapters and connected tool servers that nanobot can use from chat.",
            )}
          </p>
          <span className="text-[12px] font-medium text-muted-foreground">{caption}</span>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tx("settings.apps.searchPlaceholder", "Search Apps")}
              className="h-12 rounded-[14px] border-border/70 bg-card/90 pl-11 text-[15px] shadow-sm"
            />
          </div>
          <SegmentedControl
            value={filter}
            options={filterOptions}
            onChange={(v) => setFilter(v as AppsKindFilter)}
          />
        </div>
      </section>

      {statusMessage ? (
        <div
          className={cn(
            "flex items-center justify-between gap-3 rounded-[12px] border py-2.5 pl-4 pr-2 text-[13px]",
            statusIsError
              ? "border-destructive/20 bg-destructive/5 text-destructive"
              : "border-border/55 bg-muted/35 text-muted-foreground",
          )}
        >
          <span className="min-w-0">{statusMessage}</span>
          <button
            type="button"
            aria-label={tx("settings.actions.dismiss", "Dismiss")}
            onClick={() => setStatusMessage(null)}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
              statusIsError
                ? "text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
                : "text-muted-foreground/70 hover:bg-muted hover:text-foreground",
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {pendingRestart ? (
        <div className="flex flex-col gap-3 rounded-[12px] border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-[12.5px] text-amber-800 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
          <span>{tx("settings.mcp.restartRequired", "Restart nanobot to connect updated MCP tools.")}</span>
          {onRestart ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRestart}
              disabled={isRestarting}
              className="h-8 rounded-full bg-background/80 px-3 text-[12px] font-semibold"
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
      ) : null}

      <section>
        <div className="flex items-center justify-between border-b border-border/45 pb-3">
          <SettingsSectionTitle>{tx("settings.apps.featured", "Featured")}</SettingsSectionTitle>
          <span className="rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium text-muted-foreground">
            {items.length}
          </span>
        </div>
        {loading ? (
          <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            {tx("settings.apps.loading", "Loading Apps...")}
          </div>
        ) : items.length ? (
          <div className="grid gap-x-10 gap-y-1 py-3 md:grid-cols-2">
            {items.map((item) =>
              item.kind === "cli" ? (
                <CliAppsCatalogRow
                  key={item.id}
                  app={item.app}
                  actionKey={cliActionKey}
                  onAction={(action, name) => void handleCliAction(action, name)}
                />
              ) : (
                <McpAppsCatalogRow
                  key={item.id}
                  preset={item.preset}
                  values={mcpFieldValues[item.preset.name] ?? {}}
                  actionKey={mcpActionKey}
                  onFieldChange={(name, field, value) =>
                    setMcpFieldValues((prev) => ({
                      ...prev,
                      [name]: { ...(prev[name] ?? {}), [field]: value },
                    }))
                  }
                  onAction={(action, name, values) => void handleMcpAction(action, name, values)}
                  onToolsChange={(name, tools) => void handleMcpToolsChange(name, tools)}
                />
              ),
            )}
          </div>
        ) : (
          <div className="px-3 py-12 text-center text-sm text-muted-foreground">
            {tx("settings.apps.empty", "No apps match this filter.")}
          </div>
        )}
      </section>

      {filter !== "cli" ? (
        <McpCustomServerPanel
          form={customMcpForm}
          configImport={configImport}
          actionKey={mcpActionKey}
          onFormChange={setCustomMcpForm}
          onConfigImportChange={setConfigImport}
          onSave={() => void handleSaveCustomMcp()}
          onImportConfig={() => void handleImportConfig()}
        />
      ) : null}

      <p className="px-1 text-[11.5px] leading-5 text-muted-foreground/75">
        {t("settings.legal.thirdPartyBrands", {
          defaultValue:
            "Product names, logos, and brands are property of their respective owners. Use is for identification only and does not imply endorsement.",
        })}
      </p>
    </div>
  );
}
