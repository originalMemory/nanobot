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
const PANEL_MAX_WIDTH = 560;
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState>(DEFAULT_PANEL);
  const [prefs, setPrefs] = useState<AvatarCompanionPrefs | null>(null);
  const [visible, setVisible] = useState(false);
  const [companionMode, setCompanionMode] = useState<CompanionMode>("idle");
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
  }, []);

  // WebRTC 只在 enabled 变化时重新协商
  const enableSignal = prefs?.enabled ?? false;
  useEffect(() => {
    if (enableSignal) {
      setVisible(true);
      manualHideRef.current = false;
    }
  }, [enableSignal]);

  // 会话源绑定到桥接层（播放队列据此决定是否委托 LiveTalking）
  useEffect(() => {
    bindAvatarCompanionSession(() => activeSession?.sessionid ?? null);
    return () => bindAvatarCompanionSession(() => null);
  }, []);

  // 订阅伴侣模式(idle/working/speaking)以驱动状态标签
  useEffect(() => subscribeCompanionMode(setCompanionMode), []);

  useEffect(() => {
    if (!prefs?.enabled) return;
    let cancelled = false;
    const api = window.electronAPI?.livetalking;
    if (!api) return;

    setState("connecting");
    setError(null);

    void (async () => {
      const health = await api.checkHealth();
      if (cancelled) return;
      if (!health.reachable) {
        setState("unavailable");
        setError(health.lastError);
        return;
      }
      try {
        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        pc.ontrack = (event) => {
          if (cancelled || !videoRef.current) return;
          if (event.streams[0]) {
            videoRef.current.srcObject = event.streams[0];
          }
          void videoRef.current.play().catch(() => { /* autoplay blocked; user gesture unlocks */ });
        };
        pc.onconnectionstatechange = () => {
          if (cancelled) return;
          if (pc.connectionState === "connected") {
            setState("connected");
          } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            setState("unavailable");
            teardown();
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const answer = await api.offer(pc.localDescription?.sdp ?? offer.sdp ?? "");
        if (cancelled) return;
        if (!answer || (answer.code !== undefined && answer.code !== 0) || !answer.sdp || !answer.sessionid) {
          setState("unavailable");
          setError(answer?.msg ?? "offer failed");
          teardown();
          return;
        }
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        activeSession = { sessionid: answer.sessionid, connected: true };
      } catch (err) {
        if (cancelled) return;
        setState("unavailable");
        setError(err instanceof Error ? err.message : String(err));
        teardown();
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [prefs?.enabled, teardown]);

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
          {state === "unavailable" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center">
              <span className="text-[12px] text-amber-500">
                {tx("avatarCompanion.unavailable", "LiveTalking service unavailable")}
              </span>
              {error ? <span className="text-[10px] text-muted-foreground">{error}</span> : null}
              <span className="text-[10px] text-muted-foreground">
                {tx("avatarCompanion.audioFallback", "Voice replies play normally.")}
              </span>
            </div>
          ) : (
            <video
              ref={videoRef}
              className="h-full w-full object-contain"
              autoPlay
              playsInline
            />
          )}
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
