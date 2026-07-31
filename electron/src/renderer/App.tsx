import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { InboxSidebar } from "@/components/InboxSidebar";
import { InboxView } from "@/components/InboxView";
import { AutomationView } from "@/components/automations/AutomationView";
import { ScreenshotPreviewModal } from "@/components/ScreenshotPreviewModal";
import { SettingsView } from "@/components/settings/SettingsView";
import type { SettingsSectionKey } from "@/components/settings/shared";
import { WorkspaceView } from "@/components/workspace/WorkspaceView";
import { WallpaperLayer } from "@/components/WallpaperLayer";
import { WindowTitleBar } from "@/components/WindowTitleBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeProvider, useTheme } from "@/hooks/useTheme";
import {
  bootstrapTokenExpiresAt,
  clearSavedSecret,
  DEFAULT_GATEWAY_HTTP,
  deriveWsUrl,
  fetchBootstrap,
  loadSavedSecret,
  saveGatewayUrl,
  saveSecret,
  TOKEN_REFRESH_MIN_DELAY_MS,
  tokenRefreshDelayMs,
} from "@/lib/bootstrap";
import { fetchInboxThread, fetchSettings, updateSettings } from "@/lib/api";
import type { ReasoningEffortValue } from "@/lib/reasoning-effort";
import { bootstrapAppLanguage } from "@/i18n";
import { NanobotClient } from "@/lib/nanobot-client";
import { cn } from "@/lib/utils";
import { ClientProvider } from "@/providers/ClientProvider";
import { BotIdentityProvider, type BotIdentity } from "@/contexts/BotIdentityContext";
import type { SettingsPayload, UIMessage } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BootState =
  | { status: "loading" }
  | { status: "auth"; gatewayUrl: string; failed?: boolean }
  | { status: "error"; message: string; gatewayUrl: string }
  | {
      status: "ready";
      client: NanobotClient;
      token: string;
      tokenExpiresAt: number;
      modelName: string | null;
      initialMessages: UIMessage[];
      gatewayUrl: string;
    };

// ---------------------------------------------------------------------------
// Electron 无边框窗口布局
// ---------------------------------------------------------------------------

function ElectronFrame({ children }: { children: React.ReactNode }) {
  return (
    <WallpaperLayer>
      <div className="wallpaper-root relative z-10 flex h-full w-full flex-col overflow-hidden bg-background">
        <WindowTitleBar />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </WallpaperLayer>
  );
}

// ---------------------------------------------------------------------------
// Auth form
// ---------------------------------------------------------------------------

function AuthForm({
  failed,
  onSecret,
}: {
  failed: boolean;
  onSecret: (secret: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const secret = value.trim();
    if (!secret) return;
    setSubmitting(true);
    onSecret(secret);
  };

  return (
    <div className="flex h-full w-full items-center justify-center px-6 bg-background">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4"
      >
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-lg font-semibold text-foreground">
            {t("app.auth.title")}
          </p>
          <p className="text-sm text-muted-foreground">{t("app.auth.hint")}</p>
        </div>
        {failed && (
          <p className="text-center text-sm text-destructive">
            {t("app.auth.invalid")}
          </p>
        )}
        <Input
          type="password"
          placeholder={t("app.auth.placeholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={submitting}
          autoFocus
        />
        <Button
          type="submit"
          className="w-full"
          disabled={!value.trim() || submitting}
        >
          {t("app.auth.submit")}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 后端地址配置表单（仅在连接失败时显示）
// ---------------------------------------------------------------------------

function BackendAddressForm({
  initialUrl,
  onConnect,
}: {
  initialUrl: string;
  onConnect: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(initialUrl);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    onConnect(trimmed);
  };

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("app.error.backendAddress.placeholder")}
          className="flex-1 font-mono text-sm"
        />
        <Button type="submit" disabled={!url.trim()}>
          {t("app.error.backendAddress.connect")}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Inner shell (rendered after successful boot)
// ---------------------------------------------------------------------------

function Shell({
  client,
  token,
  modelName,
  initialMessages,
  gatewayUrl,
}: {
  client: NanobotClient;
  token: string;
  modelName: string | null;
  initialMessages: UIMessage[];
  gatewayUrl: string;
}) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [view, setView] = useState<"chat" | "settings" | "workspace" | "automations">("chat");
  const [botIdentity, setBotIdentity] = useState<BotIdentity>({ botName: "nanobot", botIcon: "", botAvatarUrl: null });
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [modelSelectionPending, setModelSelectionPending] = useState(false);
  const [modelSelectionError, setModelSelectionError] = useState<string | null>(null);
  const [reasoningSelectionPending, setReasoningSelectionPending] = useState(false);
  const [reasoningSelectionError, setReasoningSelectionError] = useState<string | null>(null);
  const [settingsNavigateSection, setSettingsNavigateSection] = useState<SettingsSectionKey | null>(null);

  const applySettings = useCallback((payload: SettingsPayload) => {
    setSettings(payload);
    setBotIdentity({
      botName: payload.agent.bot_name,
      botIcon: payload.agent.bot_icon,
      botAvatarUrl: payload.agent.bot_avatar_url,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSettings(token, gatewayUrl)
      .then((s) => {
        if (!cancelled) applySettings(s);
      })
      .catch((): void => undefined);
    return () => { cancelled = true; };
  }, [token, gatewayUrl, applySettings]);

  useEffect(() => {
    const api = window.electronAPI?.app;
    if (!api?.onOpenSettings) return;
    return api.onOpenSettings((section) => {
      setView("settings");
      const allowed: SettingsSectionKey[] = [
        "overview", "appearance", "models", "image", "web", "apps", "runtime", "deskPet", "advanced",
      ];
      if (allowed.includes(section as SettingsSectionKey)) {
        setSettingsNavigateSection(section as SettingsSectionKey);
      }
    });
  }, []);

  useEffect(() => {
    return client.onRuntimeModelUpdate((modelName, _modelPreset) => {
      if (!modelName) return;
      fetchSettings(token, gatewayUrl)
        .then(applySettings)
        .catch((): void => undefined);
    });
  }, [applySettings, client, gatewayUrl, token]);

  const handleSelectModelPreset = useCallback(async (preset: string) => {
    if (modelSelectionPending) return;
    setModelSelectionError(null);
    setModelSelectionPending(true);
    try {
      const payload = await updateSettings(token, { modelPreset: preset }, gatewayUrl);
      applySettings(payload);
    } catch (err) {
      const message = (err as Error).message;
      setModelSelectionError(
        message || t("thread.composer.modelPresetFailed", { defaultValue: "Failed to switch model" }),
      );
    } finally {
      setModelSelectionPending(false);
    }
  }, [applySettings, gatewayUrl, modelSelectionPending, t, token]);

  const handleSelectReasoningEffort = useCallback(async (effort: ReasoningEffortValue) => {
    if (reasoningSelectionPending) return;
    setReasoningSelectionError(null);
    setReasoningSelectionPending(true);
    try {
      const payload = await updateSettings(token, { reasoningEffort: effort }, gatewayUrl);
      applySettings(payload);
    } catch (err) {
      const message = (err as Error).message;
      setReasoningSelectionError(
        message || t("thread.composer.reasoningMode.failed", { defaultValue: "Failed to update thinking mode" }),
      );
    } finally {
      setReasoningSelectionPending(false);
    }
  }, [applySettings, gatewayUrl, reasoningSelectionPending, t, token]);

  const dismissModelSelectionError = useCallback(() => {
    setModelSelectionError(null);
  }, []);

  const dismissReasoningSelectionError = useCallback(() => {
    setReasoningSelectionError(null);
  }, []);

  // 截图流程（8.2）：
  // pendingPreview = 等待用户在 Modal 中确认的截图
  // pendingAttach  = 用户已确认、等待 ThreadComposer 消费的截图
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [pendingAttach, setPendingAttach] = useState<string | null>(null);
  const [focusComposerSignal, setFocusComposerSignal] = useState(0);

  const handleRaiseInboxShortcut = useCallback(({ toggle }: { toggle: boolean }) => {
    if (toggle && view === "chat" && activeChannel === null) {
      void window.electronAPI?.window?.action("close");
      return;
    }
    setView("chat");
    setActiveChannel(null);
    setFocusComposerSignal((n) => n + 1);
  }, [view, activeChannel]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.shortcut?.onRaiseInbox) return;
    return window.electronAPI.shortcut.onRaiseInbox(handleRaiseInboxShortcut);
  }, [handleRaiseInboxShortcut]);

  // 订阅主进程全局快捷键推送的截图事件（8.1）
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.screenshot?.onCapture) return;
    const cleanup = window.electronAPI.screenshot.onCapture((dataUrl) => {
      setPendingPreview(dataUrl);
    });
    return cleanup;
  }, []);

  // 订阅服务端发起的截图请求：捕获 JPEG 后经 WebSocket 回传 screenshot_result。
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.screenshot?.capture) return;
    return client.onScreenshotRequest(async (requestId) => {
      const dataUrl = await window.electronAPI.screenshot.capture();
      if (dataUrl) client.sendScreenshotResult(requestId, dataUrl);
    });
  }, [client]);

  // 订阅窗口焦点变更，经 WebSocket 上报 presence 给服务端；
  // 连接建立时先同步一次当前状态，此后每次 focus/blur 实时推送。
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.presence?.onChange) return;
    // 连接建立后立即同步当前焦点状态
    client.sendPresence(document.hasFocus());
    const cleanup = window.electronAPI.presence.onChange((focused) => {
      client.sendPresence(focused);
    });
    return cleanup;
  }, [client]);

  const handleScreenshotConfirm = useCallback((dataUrl: string) => {
    setPendingPreview(null);
    setPendingAttach(dataUrl);
  }, []);

  const handleScreenshotCancel = useCallback(() => {
    setPendingPreview(null);
  }, []);

  // 用户点击 Composer 截图按钮时主动调用 capture（与快捷键触发的弹窗走同一条路径）
  const handleCaptureScreenshot = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI?.screenshot?.capture) return;
    const dataUrl = await window.electronAPI.screenshot.capture();
    if (dataUrl) setPendingPreview(dataUrl);
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <ClientProvider client={client} token={token} modelName={modelName} apiBase={gatewayUrl}>
        <BotIdentityProvider value={botIdentity}>
        <div className="wallpaper-root flex h-full w-full overflow-hidden bg-background text-foreground">
          {/* Sidebar */}
          <InboxSidebar
            activeChannel={activeChannel}
            onSelectChannel={(ch) => { setActiveChannel(ch); setView("chat"); }}
            channels={channels}
            theme={theme}
            onThemeChange={setTheme}
            onOpenSettings={() => setView("settings")}
            onOpenWorkspace={() => setView("workspace")}
            onOpenAutomations={() => setView("automations")}
            settingsActive={view === "settings"}
            workspaceActive={view === "workspace"}
            automationsActive={view === "automations"}
          />

          {/* Main area */}
          <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div
              className={cn(
                "flex h-full min-h-0 flex-1 flex-col overflow-hidden",
                view !== "chat" && "hidden",
              )}
              aria-hidden={view !== "chat"}
            >
              <InboxView
                initialMessages={initialMessages}
                activeChannel={activeChannel}
                onChannelsChange={setChannels}
                pendingScreenshot={pendingAttach}
                onScreenshotConsumed={() => setPendingAttach(null)}
                onCaptureScreenshot={handleCaptureScreenshot}
                modelSettings={settings}
                modelSelectionPending={modelSelectionPending}
                modelSelectionError={modelSelectionError}
                onDismissModelSelectionError={dismissModelSelectionError}
                onModelPresetSelect={handleSelectModelPreset}
                reasoningSelectionPending={reasoningSelectionPending}
                reasoningSelectionError={reasoningSelectionError}
                onDismissReasoningSelectionError={dismissReasoningSelectionError}
                onReasoningEffortSelect={handleSelectReasoningEffort}
                focusComposerSignal={focusComposerSignal}
              />
            </div>
            {view === "settings" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <SettingsView
                  onBack={() => setView("chat")}
                  theme={theme}
                  onThemeChange={setTheme}
                  onSettingsChange={applySettings}
                  navigateSection={settingsNavigateSection}
                />
              </div>
            ) : view === "workspace" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <WorkspaceView
                  token={token}
                  gatewayUrl={gatewayUrl}
                  workspacePath={settings?.runtime.workspace_path ?? null}
                  onBack={() => setView("chat")}
                />
              </div>
            ) : view === "automations" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <AutomationView
                  token={token}
                  gatewayUrl={gatewayUrl}
                  onBack={() => setView("chat")}
                />
              </div>
            ) : null}
          </main>
        </div>

        {/* Screenshot preview / confirm modal */}
        <ScreenshotPreviewModal
          dataUrl={pendingPreview}
          onConfirm={handleScreenshotConfirm}
          onCancel={handleScreenshotCancel}
        />
        </BotIdentityProvider>
      </ClientProvider>
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------

export default function App() {
  const { t } = useTranslation();
  const [state, setState] = useState<BootState>({ status: "loading" });
  const bootstrapSecretRef = useRef("");
  const gatewayUrlRef = useRef(DEFAULT_GATEWAY_HTTP);

  const bootstrapWithSecret = useCallback(
    (secret: string, gatewayUrl?: string) => {
      let cancelled = false;

      (async () => {
        // Close any existing client before transitioning to loading
        setState((prev) => {
          if (prev.status === "ready") {
            queueMicrotask(() => prev.client.close());
          }
          return { status: "loading" };
        });

        // Resolve URL: prefer explicit arg, then last known gateway (#6)
        const url = gatewayUrl !== undefined ? gatewayUrl : gatewayUrlRef.current;
        gatewayUrlRef.current = url;

        try {
          const boot = await fetchBootstrap(url, secret);
          if (cancelled) return;

          // Only persist non-empty secrets (#5)
          if (secret) {
            saveSecret(secret);
            bootstrapSecretRef.current = secret;
          }
          void saveGatewayUrl(url);

          // Load inbox thread before connecting so initial messages are available
          // before any real-time events arrive (#3)
          let initialMessages: UIMessage[] = [];
          try {
            const thread = await fetchInboxThread(boot.token, url);
            if (!cancelled) {
              initialMessages = thread?.messages ?? [];
            }
          } catch (histErr) {
            console.warn("[nanobot] fetchInboxThread failed, starting with empty history:", histErr);
          }

          if (cancelled) return;

          const wsUrl = deriveWsUrl(boot.ws_path, boot.token, url);
          const client = new NanobotClient({
            url: wsUrl,
            onReauth: async () => {
              try {
                const refreshed = await fetchBootstrap(url, bootstrapSecretRef.current);
                const refreshedUrl = deriveWsUrl(refreshed.ws_path, refreshed.token, url);
                const tokenExpiresAt = bootstrapTokenExpiresAt(refreshed.expires_in);
                setState((current) =>
                  current.status === "ready" && current.client === client
                    ? {
                        ...current,
                        token: refreshed.token,
                        tokenExpiresAt,
                        modelName: refreshed.model_name ?? current.modelName,
                      }
                    : current,
                );
                return refreshedUrl;
              } catch {
                return null;
              }
            },
          });
          client.connect();

          setState({
            status: "ready",
            client,
            token: boot.token,
            tokenExpiresAt: bootstrapTokenExpiresAt(boot.expires_in),
            modelName: boot.model_name ?? null,
            initialMessages,
            gatewayUrl: url,
          });
        } catch (e) {
          if (cancelled) return;
          const httpStatus = (e as Error & { httpStatus?: number }).httpStatus;
          const msg = (e as Error).message;
          // Check numeric status code first, fall back to message string (#7)
          if (httpStatus === 401 || httpStatus === 403 || msg.includes("401") || msg.includes("403")) {
            setState({ status: "auth", gatewayUrl: url, failed: true });
          } else {
            setState({ status: "error", message: msg, gatewayUrl: url });
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    },
    [],
  );

  useEffect(() => {
    void bootstrapAppLanguage();
  }, []);

  // 在 REST token 过期前主动刷新，避免长时间停留后打开设置页出现 HTTP 401
  useEffect(() => {
    if (state.status !== "ready") return;
    const { client, gatewayUrl } = state;
    let cancelled = false;
    let timer: number | undefined;

    const scheduleRefresh = (delayMs: number) => {
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshToken();
      }, delayMs);
    };

    const refreshToken = async () => {
      try {
        const boot = await fetchBootstrap(gatewayUrl, bootstrapSecretRef.current);
        if (cancelled) return;
        const wsUrl = deriveWsUrl(boot.ws_path, boot.token, gatewayUrl);
        const tokenExpiresAt = bootstrapTokenExpiresAt(boot.expires_in);
        client.updateUrl(wsUrl);
        setState((current) =>
          current.status === "ready" && current.client === client
            ? {
                ...current,
                token: boot.token,
                tokenExpiresAt,
                modelName: boot.model_name ?? current.modelName,
              }
            : current,
        );
      } catch (e) {
        const httpStatus = (e as Error & { httpStatus?: number }).httpStatus;
        const msg = (e as Error).message;
        if (cancelled) return;
        if (httpStatus === 401 || httpStatus === 403 || msg.includes("401") || msg.includes("403")) {
          setState((current) => {
            if (current.status === "ready" && current.client === client) {
              current.client.close();
            }
            return { status: "auth", gatewayUrl: gatewayUrlRef.current, failed: true };
          });
        } else {
          scheduleRefresh(TOKEN_REFRESH_MIN_DELAY_MS);
        }
      }
    };

    scheduleRefresh(tokenRefreshDelayMs(state.tokenExpiresAt));
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [state]);

  // gateway 连上后通知主进程尝试自动打开 PSB 桌宠
  const bootReadyKey =
    state.status === "ready" ? `${state.gatewayUrl}:${state.token}` : null;
  useEffect(() => {
    if (!bootReadyKey || state.status !== "ready") return;
    void window.electronAPI?.psb?.tryAutoOpen?.(state.token, state.gatewayUrl);
  }, [bootReadyKey, state.gatewayUrl, state.status, state.token]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    (async () => {
      let url = DEFAULT_GATEWAY_HTTP;
      let secret = "";

      if (typeof window !== "undefined" && window.electronAPI) {
        try {
          const gateway = await window.electronAPI.config.get("gateway") as {
            url?: string;
          } | undefined;
          url = gateway?.url ?? DEFAULT_GATEWAY_HTTP;
        } catch {
          // fall back to localStorage / defaults
        }
      }

      if (!secret) {
        secret = loadSavedSecret();
      }

      cleanup = bootstrapWithSecret(secret, url);
    })();
    return () => cleanup?.();
  }, [bootstrapWithSecret]);

  const handleLogout = useCallback(() => {
    if (state.status === "ready") {
      state.client.close();
    }
    clearSavedSecret();
    setState({ status: "auth", gatewayUrl: gatewayUrlRef.current });
  }, [state]);

  if (state.status === "loading") {
    return (
      <ElectronFrame>
        <div className="flex h-full w-full items-center justify-center bg-background">
          <div className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in-0 duration-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-foreground/60" />
            </span>
            {t("app.loading.connecting")}
          </div>
        </div>
      </ElectronFrame>
    );
  }

  if (state.status === "auth") {
    return (
      <ElectronFrame>
        <AuthForm
          failed={!!state.failed}
          onSecret={(s) => bootstrapWithSecret(s, state.gatewayUrl)}
        />
      </ElectronFrame>
    );
  }

  if (state.status === "error") {
    return (
      <ElectronFrame>
        <div className="flex h-full w-full items-center justify-center px-4 text-center bg-background">
          <div className="flex w-full max-w-sm flex-col items-center gap-4">
            <div className="flex flex-col items-center gap-1">
              <p className="text-lg font-semibold text-foreground">{t("app.error.title")}</p>
              <p className="text-sm text-muted-foreground">{state.message}</p>
            </div>
            <BackendAddressForm
              initialUrl={state.gatewayUrl ?? DEFAULT_GATEWAY_HTTP}
              onConnect={(url) => {
                saveGatewayUrl(url);
                bootstrapWithSecret(bootstrapSecretRef.current, url);
              }}
            />
          </div>
        </div>
      </ElectronFrame>
    );
  }

  return (
    <ElectronFrame>
      <Shell
        client={state.client}
        token={state.token}
        modelName={state.modelName}
        initialMessages={state.initialMessages}
        gatewayUrl={state.gatewayUrl}
      />
    </ElectronFrame>
  );
}
