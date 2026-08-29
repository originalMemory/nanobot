// 数字伴侣面板：WebRTC 连接 LiveTalking 并播放数字人音视频流
// 启用且服务健康时显示；连接失败显示非阻塞不可用状态。
// 位置/大小/收起状态持久化到 avatarCompanion.panel（本地 electron-store）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { bindAvatarCompanionSession, subscribeCompanionMode, type CompanionMode } from "@/lib/livetalking-bridge";

type ConnectionState = "idle" | "connecting" | "connected" | "unavailable";

type AvatarCompanionPrefs = {
  enabled: boolean;
  serverUrl: string;
  timeoutMs: number;
};

type PanelState = {
  x: number | null;
  y: number | null;
  width: number;
  collapsed: boolean;
};

const PANEL_MIN_WIDTH = 200;
const PANEL_MAX_WIDTH = 1120;
const DEFAULT_PANEL: PanelState = { x: null, y: null, width: 288, collapsed: false };

export type AvatarCompanionSession = {
  sessionid: string | null;
  connected: boolean;
};

let activeSession: AvatarCompanionSession | null = null;

/** 供播放队列集成的单例访问：当前会话 id（未连接为 null）。 */
export function getAvatarCompanionSession(): AvatarCompanionSession | null {
  return activeSession;
}

function clampWidth(w: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(w)));
}

export function AvatarCompanionPanel() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const connectRef = useRef<Promise<boolean> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState>(DEFAULT_PANEL);
  const [prefs, setPrefs] = useState<AvatarCompanionPrefs | null>(null);
  const [visible, setVisible] = useState(false);
  const [companionMode, setCompanionMode] = useState<CompanionMode>("idle");
  const [localVideos, setLocalVideos] = useState<{ idle: string[]; working: string[] }>({ idle: [], working: [] });
  const [localSources, setLocalSources] = useState<[string, string]>(["", ""]);
  const [activeLocalLayer, setActiveLocalLayer] = useState<0 | 1>(0);
  const localModeRef = useRef<"idle" | "working" | null>(null);
  const localFadeTimerRef = useRef<number | null>(null);
  const manualHideRef = useRef(false);
  const dragState = useRef<{ kind: "move" | "resize"; startX: number; startY: number; base: PanelState } | null>(null);

  const persistPanel = useCallback((next: PanelState) => {
    const api = window.electronAPI;
    if (!api?.config?.get || !api?.config?.set) return;
    void api.config.get("avatarCompanion").then((stored) => {
      const current = (stored ?? {}) as Record<string, unknown>;
      void api.config.set("avatarCompanion", { ...current, panel: next });
    });
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.config?.get) return;
    let lastEnabled: boolean | null = null;
    const read = () => {
      void api.config.get("avatarCompanion").then((stored) => {
        const partial = (stored ?? {}) as Partial<AvatarCompanionPrefs> & { panel?: Partial<PanelState> };
        const next = {
          enabled: partial.enabled ?? false,
          serverUrl: partial.serverUrl ?? "http://127.0.0.1:8010",
          timeoutMs: partial.timeoutMs ?? 3000,
        };
        setPrefs(next);
        const storedPanel = partial.panel;
        if (storedPanel) {
          setPanel((current) => ({
            x: typeof storedPanel.x === "number" ? storedPanel.x : current.x,
            y: typeof storedPanel.y === "number" ? storedPanel.y : current.y,
            width: typeof storedPanel.width === "number" ? clampWidth(storedPanel.width) : current.width,
            collapsed: storedPanel.collapsed ?? current.collapsed,
          }));
        }
        if (lastEnabled === null || lastEnabled !== next.enabled) {
          if (next.enabled && !manualHideRef.current) setVisible(true);
          if (!next.enabled) setVisible(false);
        }
        lastEnabled = next.enabled;
      });
    };
    read();
    const timer = window.setInterval(read, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const teardown = useCallback(() => {
    const pc = pcRef.current;
    pcRef.current = null;
    activeSession = null;
    if (pc) {
      pc.getSenders().forEach((sender) => {
        try { sender.track?.stop(); } catch { /* already stopped */ }
      });
      void pc.close();
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
  }, []);

  // 启用只控制面板显示；WebRTC 延迟到第一段说话音频。
  const enableSignal = prefs?.enabled ?? false;
  useEffect(() => {
    if (enableSignal) {
      setVisible(true);
      manualHideRef.current = false;
    }
  }, [enableSignal]);

  // 只探测服务状态，不创建 WebRTC 会话；离线时立即给出重试入口。
  useEffect(() => {
    if (!prefs?.enabled) return;
    const api = window.electronAPI?.livetalking;
    if (!api) return;
    let cancelled = false;
    void api.checkHealth().then((health) => {
      if (cancelled || activeSession) return;
      if (health.reachable) {
        setState("idle");
        setError(null);
      } else {
        setState("unavailable");
        setError(health.lastError);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [prefs?.enabled, prefs?.serverUrl]);

  // 订阅伴侣模式(idle/working/speaking)以驱动状态标签
  useEffect(() => subscribeCompanionMode(setCompanionMode), []);

  useEffect(() => () => {
    if (localFadeTimerRef.current !== null) window.clearTimeout(localFadeTimerRef.current);
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.livetalking;
    if (!api) return;
    void api.localVideos().then((videos) => {
      setLocalVideos(videos);
    });
  }, []);

  useEffect(() => {
    if (companionMode === "speaking") return;
    const mode = companionMode === "working" ? "working" : "idle";
    const choices = localVideos[mode];
    if (!choices.length) return;
    const source = choices[Math.floor(Math.random() * choices.length)];
    const previousMode = localModeRef.current;
    localModeRef.current = mode;

    if (previousMode === null || previousMode === mode) {
      setLocalSources((current) => current.map((value, index) => (
        index === activeLocalLayer ? source : value
      )) as [string, string]);
      return;
    }

    const nextLayer = activeLocalLayer === 0 ? 1 : 0;
    setLocalSources((current) => current.map((value, index) => (
      index === nextLayer ? source : value
    )) as [string, string]);
    window.requestAnimationFrame(() => setActiveLocalLayer(nextLayer));
    if (localFadeTimerRef.current !== null) window.clearTimeout(localFadeTimerRef.current);
    localFadeTimerRef.current = window.setTimeout(() => {
      setLocalSources((current) => current.map((value, index) => (
        index === nextLayer ? value : ""
      )) as [string, string]);
      localFadeTimerRef.current = null;
    }, 350);
  }, [companionMode, localVideos]);

  const rotateLocalVideo = useCallback((layer: number) => {
    if (layer !== activeLocalLayer) return;
    setLocalSources((current) => {
      const choices = localVideos[localModeRef.current ?? "idle"];
      const candidates = choices.filter((source) => source !== current[layer]);
      if (!candidates.length) return current;
      const next = [...current] as [string, string];
      next[layer] = candidates[Math.floor(Math.random() * candidates.length)];
      return next;
    });
  }, [activeLocalLayer, localVideos]);

  const connect = useCallback((): Promise<boolean> => {
    if (activeSession?.connected && pcRef.current) return Promise.resolve(true);
    if (connectRef.current) return connectRef.current;
    if (!prefs?.enabled) return Promise.resolve(false);
    const api = window.electronAPI?.livetalking;
    if (!api) return Promise.resolve(false);

    setState("connecting");
    setError(null);

    const task = (async () => {
      const health = await api.checkHealth();
      if (!health.reachable) {
        setState("unavailable");
        setError(health.lastError);
        return false;
      }
      try {
        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        pc.ontrack = (event) => {
          if (!videoRef.current) return;
          if (event.streams[0]) {
            videoRef.current.srcObject = event.streams[0];
          }
          void videoRef.current.play().catch(() => { /* autoplay blocked; user gesture unlocks */ });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "connected") {
            setState("connected");
          } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            teardown();
            if (pc.connectionState === "failed") setState("unavailable");
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const answer = await api.offer(pc.localDescription?.sdp ?? offer.sdp ?? "");
        if (!answer || (answer.code !== undefined && answer.code !== 0) || !answer.sdp || !answer.sessionid) {
          teardown();
          setState("unavailable");
          setError(answer?.msg ?? "offer failed");
          return false;
        }
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        activeSession = { sessionid: answer.sessionid, connected: true };
        return true;
      } catch (err) {
        teardown();
        setState("unavailable");
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    })().finally(() => {
      connectRef.current = null;
    });
    connectRef.current = task;
    return task;
  }, [prefs?.enabled, teardown]);

  useEffect(() => {
    bindAvatarCompanionSession(() => activeSession?.sessionid ?? null, connect, teardown);
    return () => {
      bindAvatarCompanionSession(() => null);
      teardown();
    };
  }, [connect, teardown]);

  // 拖拽移动（标题栏）与宽度缩放（右下手柄），指针事件统一挂 window
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragState.current;
      if (!drag) return;
      if (drag.kind === "move") {
        setPanel((current) => ({
          ...current,
          x: drag.base.x === null ? null : drag.base.x + (e.clientX - drag.startX),
          y: drag.base.y === null ? null : drag.base.y + (e.clientY - drag.startY),
        }));
      } else {
        setPanel((current) => ({ ...current, width: clampWidth(drag.base.width + (e.clientX - drag.startX)) }));
      }
    };
    const onUp = () => {
      if (!dragState.current) return;
      dragState.current = null;
      document.body.style.userSelect = "";
      setPanel((current) => {
        persistPanel(current);
        return current;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [persistPanel]);

  if (!visible) return null;

  const style: React.CSSProperties = { width: panel.width };
  if (panel.x !== null && panel.y !== null) {
    style.left = panel.x;
    style.top = panel.y;
    style.right = "auto";
  }

  const stateLabel =
    state === "unavailable"
      ? tx("avatarCompanion.stateUnavailable", "Offline")
      : companionMode === "speaking"
        ? tx("avatarCompanion.stateSpeaking", "Speaking")
        : companionMode === "working"
          ? tx("avatarCompanion.stateWorking", "Working")
          : tx("avatarCompanion.stateIdle", "Idle");

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto absolute right-4 top-4 z-30 overflow-hidden rounded-xl border border-border/60 bg-card/90 shadow-lg backdrop-blur"
      style={style}
    >
      <div
        className="flex cursor-move items-center justify-between px-3 py-2"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const rect = rootRef.current?.getBoundingClientRect();
          const parentRect = rootRef.current?.parentElement?.getBoundingClientRect();
          const base: PanelState = {
            ...panel,
            x: panel.x ?? (rect && parentRect ? rect.left - parentRect.left : null),
            y: panel.y ?? (rect && parentRect ? rect.top - parentRect.top : null),
          };
          dragState.current = { kind: "move", startX: e.clientX, startY: e.clientY, base };
          document.body.style.userSelect = "none";
        }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              const next = { ...panel, collapsed: !panel.collapsed };
              setPanel(next);
              persistPanel(next);
            }}
            aria-label={panel.collapsed ? tx("avatarCompanion.expand", "Expand") : tx("avatarCompanion.collapse", "Collapse")}
          >
            {panel.collapsed ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
          </button>
          <span className="text-[12px] font-medium text-muted-foreground select-none">{stateLabel}</span>
          <span
            className={`h-2 w-2 rounded-full ${
              state === "connected" ? "bg-emerald-500" : state === "connecting" ? "bg-amber-400" : "bg-red-400"
            }`}
            aria-hidden
          />
        </div>
        <button
          type="button"
          className="text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            manualHideRef.current = true;
            setVisible(false);
          }}
          aria-label={tx("avatarCompanion.hide", "Hide")}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {!panel.collapsed ? (
        <div className="relative aspect-[4/3] w-full bg-black/85">
          <div className={`absolute inset-0 transition-opacity duration-300 ${companionMode === "speaking" && state === "connected" ? "opacity-0" : "opacity-100"}`}>
            {localSources.map((source, index) => source ? (
              <video
                key={index}
                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${activeLocalLayer === index ? "opacity-100" : "opacity-0"}`}
                src={source}
                autoPlay
                muted
                playsInline
                onEnded={() => rotateLocalVideo(index)}
              />
            ) : null)}
          </div>
          <video
            ref={videoRef}
            className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${companionMode === "speaking" && state === "connected" ? "opacity-100" : "opacity-0"}`}
            autoPlay
            playsInline
          />
          {state === "unavailable" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 p-4 text-center">
              <span className="text-[12px] text-amber-500">
                {tx("avatarCompanion.unavailable", "LiveTalking service unavailable")}
              </span>
              {error ? <span className="text-[10px] text-muted-foreground">{error}</span> : null}
              <span className="text-[10px] text-muted-foreground">
                {tx("avatarCompanion.audioFallback", "Voice replies play normally.")}
              </span>
              <button
                type="button"
                className="mt-2 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-muted"
                onClick={() => void connect()}
              >
                {tx("avatarCompanion.retry", "Retry")}
              </button>
            </div>
          ) : null}
          <div
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
            onPointerDown={(e) => {
              e.stopPropagation();
              dragState.current = { kind: "resize", startX: e.clientX, startY: e.clientY, base: panel };
              document.body.style.userSelect = "none";
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
