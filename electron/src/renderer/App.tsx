import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { InboxSidebar } from "@/components/InboxSidebar";
import { InboxView } from "@/components/InboxView";
import { ScreenshotPreviewModal } from "@/components/ScreenshotPreviewModal";
import { SettingsView } from "@/components/settings/SettingsView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeProvider, useTheme } from "@/hooks/useTheme";
import {
  clearSavedSecret,
  DEFAULT_GATEWAY_HTTP,
  deriveWsUrl,
  fetchBootstrap,
  loadSavedSecret,
  saveGatewayUrl,
  saveSecret,
} from "@/lib/bootstrap";
import { fetchInboxThread, fetchSettings } from "@/lib/api";
import { NanobotClient } from "@/lib/nanobot-client";
import { ClientProvider } from "@/providers/ClientProvider";
import { BotIdentityProvider, type BotIdentity } from "@/contexts/BotIdentityContext";
import type { UIMessage } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BootState =
  | { status: "loading" }
  | { status: "auth"; failed?: boolean }
  | { status: "error"; message: string; gatewayUrl: string }
  | {
      status: "ready";
      client: NanobotClient;
      token: string;
      modelName: string | null;
      initialMessages: UIMessage[];
      gatewayUrl: string;
    };

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
  const { theme, setTheme } = useTheme();
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [botIdentity, setBotIdentity] = useState<BotIdentity>({ botName: "nanobot", botIcon: "", botAvatarUrl: null });

  useEffect(() => {
    let cancelled = false;
    fetchSettings(token, gatewayUrl)
      .then((s) => {
        if (!cancelled) {
          setBotIdentity({
            botName: s.agent.bot_name,
            botIcon: s.agent.bot_icon,
            botAvatarUrl: s.agent.bot_avatar_url,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token, gatewayUrl]);

  // 截图流程（8.2）：
  // pendingPreview = 等待用户在 Modal 中确认的截图
  // pendingAttach  = 用户已确认、等待 ThreadComposer 消费的截图
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [pendingAttach, setPendingAttach] = useState<string | null>(null);

  // 订阅主进程全局快捷键推送的截图事件（8.1）
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.screenshot?.onCapture) return;
    const cleanup = window.electronAPI.screenshot.onCapture((dataUrl) => {
      setPendingPreview(dataUrl);
    });
    return cleanup;
  }, []);

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
        <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
          {/* Sidebar */}
          <InboxSidebar
            activeChannel={activeChannel}
            onSelectChannel={(ch) => { setActiveChannel(ch); setView("chat"); }}
            channels={channels}
            theme={theme}
            onThemeChange={setTheme}
            onOpenSettings={() => setView("settings")}
            settingsActive={view === "settings"}
          />

          {/* Main area */}
          <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            {view === "settings" ? (
              <SettingsView onBack={() => setView("chat")} theme={theme} onThemeChange={setTheme} />
            ) : (
              <InboxView
                initialMessages={initialMessages}
                activeChannel={activeChannel}
                onChannelsChange={setChannels}
                pendingScreenshot={pendingAttach}
                onScreenshotConsumed={() => setPendingAttach(null)}
                onCaptureScreenshot={handleCaptureScreenshot}
              />
            )}
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

        try {
          const boot = await fetchBootstrap(url, secret);
          if (cancelled) return;

          // Only persist non-empty secrets (#5)
          if (secret) {
            saveSecret(secret);
            bootstrapSecretRef.current = secret;
          }
          gatewayUrlRef.current = url;

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
                setState((current) =>
                  current.status === "ready"
                    ? { ...current, token: refreshed.token }
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
            setState({ status: "auth", failed: true });
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
    let cleanup: (() => void) | undefined;
    (async () => {
      let url = DEFAULT_GATEWAY_HTTP;
      let secret = "";

      if (typeof window !== "undefined" && window.electronAPI) {
        try {
          const gateway = await window.electronAPI.config.get("gateway") as {
            url?: string;
            token?: string;
          } | undefined;
          url = gateway?.url ?? DEFAULT_GATEWAY_HTTP;
          secret = gateway?.token ?? "";
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
    setState({ status: "auth" });
  }, [state]);

  if (state.status === "loading") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in-0 duration-300">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-foreground/60" />
          </span>
          {t("app.loading.connecting")}
        </div>
      </div>
    );
  }

  if (state.status === "auth") {
    return (
      <AuthForm
        failed={!!state.failed}
        onSecret={(s) => bootstrapWithSecret(s)}
      />
    );
  }

  if (state.status === "error") {
    return (
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
    );
  }

  return (
    <Shell
      client={state.client}
      token={state.token}
      modelName={state.modelName}
      initialMessages={state.initialMessages}
      gatewayUrl={state.gatewayUrl}
    />
  );
}
