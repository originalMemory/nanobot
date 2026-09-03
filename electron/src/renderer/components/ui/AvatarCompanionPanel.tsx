// 数字伴侣面板：待机/工作动画本地播放；说话环节按 livetalking 开关交给 LiveTalking 数字人
// 数字伴侣开关只控制面板显示；LiveTalking 不可用不遮盖画面，仅在头部状态旁提供重试。
// 位置/大小/收起状态持久化到 avatarCompanion.panel（本地 electron-store）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { subscribeAvatarCompanionPrefs } from "@/lib/avatar-companion-events";
import {
  avatarCompanionInterrupt,
  bindAvatarCompanionSession,
  subscribeCompanionMode,
  type CompanionMode,
} from "@/lib/livetalking-bridge";

type ConnectionState = "idle" | "ready" | "connecting" | "connected" | "unavailable";

type AvatarCompanionPrefs = {
  enabled: boolean;
  livetalking: boolean;
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
  const [fadeLocalSwitch, setFadeLocalSwitch] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const localModeRef = useRef<"idle" | "working" | null>(null);
  const pendingLocalSwitchRef = useRef<{ layer: 0 | 1; fade: boolean } | null>(null);
  const localFadeTimerRef = useRef<number | null>(null);
  const recentLocalSourcesRef = useRef<Record<"idle" | "working", string[]>>({ idle: [], working: [] });
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
          livetalking: partial.livetalking ?? true,
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
    return subscribeAvatarCompanionPrefs(read);
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
    setRemoteReady(false);
    setState("ready");
  }, []);

  // 启用只控制面板显示；WebRTC 延迟到第一段说话音频。
  const enableSignal = prefs?.enabled ?? false;
  useEffect(() => {
    if (enableSignal) {
      setVisible(true);
      manualHideRef.current = false;
    }
  }, [enableSignal]);

  // 关闭数字伴侣或 LiveTalking 即完全关闭：打断并拆除活动会话，避免隐性继续委托语音
  useEffect(() => {
    if ((prefs?.enabled ?? false) && (prefs?.livetalking ?? true)) return;
    if (!activeSession) return;
    avatarCompanionInterrupt();
  }, [prefs?.enabled, prefs?.livetalking]);

  // 只探测服务状态，不创建 WebRTC 会话；仅 livetalking 开启时探测，离线在头部给出重试入口。
  useEffect(() => {
    if (!prefs?.enabled) return;
    if (!prefs?.livetalking) {
      if (!activeSession) {
        setState("ready");
        setError(null);
      }
      return;
    }
    const api = window.electronAPI?.livetalking;
    if (!api) return;
    let cancelled = false;
    void api.checkHealth().then((health) => {
      if (cancelled || activeSession) return;
      if (health.reachable) {
        setState("ready");
        setError(null);
      } else {
        setState("unavailable");
        setError(health.lastError);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [prefs?.enabled, prefs?.livetalking, prefs?.serverUrl]);

  // 订阅伴侣模式(idle/working/speaking)以驱动状态标签
  useEffect(() => subscribeCompanionMode(setCompanionMode), []);

  useEffect(() => () => {
    if (localFadeTimerRef.current !== null) window.clearTimeout(localFadeTimerRef.current);
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.livetalking;
    if (!api) return;
    let cancelled = false;
    const refresh = () => {
      void api.localVideos().then((videos) => {
        if (cancelled) return;
        setLocalVideos((current) => (
          current.idle.join("\n") === videos.idle.join("\n")
          && current.working.join("\n") === videos.working.join("\n")
            ? current
            : { idle: videos.idle, working: videos.working }
        ));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    prefs?.videoDirectory,
    prefs?.timeSchedule?.sunrise,
    prefs?.timeSchedule?.day,
    prefs?.timeSchedule?.sunset,
    prefs?.timeSchedule?.night,
  ]);

  useEffect(() => {
    if (companionMode === "speaking") return;
    const mode = companionMode === "working" ? "working" : "idle";
    const choices = localVideos[mode];
    if (!choices.length) return;
    const recent = recentLocalSourcesRef.current[mode];
    const available = choices.filter((source) => !recent.includes(source));
    const source = (available.length ? available : choices)[Math.floor(Math.random() * (available.length || choices.length))];
    recent.push(source);
    if (recent.length > 3) recent.shift();
    const previousMode = localModeRef.current;
    localModeRef.current = mode;

    if (previousMode === null || previousMode === mode) {
      setLocalSources((current) => current.map((value, index) => (
        index === activeLocalLayer ? source : value
      )) as [string, string]);
      return;
    }

    const nextLayer = activeLocalLayer === 0 ? 1 : 0;
    pendingLocalSwitchRef.current = { layer: nextLayer, fade: true };
    setLocalSources((current) => current.map((value, index) => (
      index === nextLayer ? source : value
    )) as [string, string]);
  }, [companionMode, localVideos]);

  const rotateLocalVideo = useCallback((layer: number) => {
    if (layer !== activeLocalLayer) return;
    const nextLayer = (activeLocalLayer === 0 ? 1 : 0) as 0 | 1;
    const choices = localVideos[localModeRef.current ?? "idle"];
    const candidates = choices.filter((source) => source !== localSources[layer]);
    if (!candidates.length) return;
    const mode = localModeRef.current ?? "idle";
    const recent = recentLocalSourcesRef.current[mode];
    const available = candidates.filter((source) => !recent.includes(source));
    const source = (available.length ? available : candidates)[Math.floor(Math.random() * (available.length || candidates.length))];
    recent.push(source);
    if (recent.length > 3) recent.shift();
    pendingLocalSwitchRef.current = { layer: nextLayer, fade: false };
    setLocalSources((current) => current.map((value, index) => (
      index === nextLayer ? source : value
    )) as [string, string]);
  }, [activeLocalLayer, localSources, localVideos]);

  const finishLocalSwitch = useCallback((layer: number) => {
    const pending = pendingLocalSwitchRef.current;
    if (!pending || pending.layer !== layer) return;
    pendingLocalSwitchRef.current = null;
    setFadeLocalSwitch(pending.fade);
    setActiveLocalLayer(pending.layer);
    if (localFadeTimerRef.current !== null) window.clearTimeout(localFadeTimerRef.current);
    localFadeTimerRef.current = window.setTimeout(() => {
      setLocalSources((current) => current.map((value, index) => (
        index === pending.layer ? value : ""
      )) as [string, string]);
      setFadeLocalSwitch(false);
      localFadeTimerRef.current = null;
    }, pending.fade ? 350 : 0);
  }, []);

  const connect = useCallback((): Promise<boolean> => {
    if (activeSession?.connected && pcRef.current) return Promise.resolve(true);
    if (connectRef.current) return connectRef.current;
    if (!prefs?.enabled || !prefs?.livetalking) return Promise.resolve(false);
    const api = window.electronAPI?.livetalking;
    if (!api) return Promise.resolve(false);

    setState("connecting");
    setError(null);
    setRemoteReady(false);

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
  }, [prefs?.enabled, prefs?.livetalking, teardown]);

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
              state === "connected" || state === "ready"
                ? "bg-emerald-500"
                : state === "connecting"
                  ? "bg-amber-400"
                  : state === "unavailable"
                    ? "bg-red-400"
                    : "bg-muted-foreground"
            }`}
            aria-hidden
          />
          {state === "unavailable" ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={`${tx("avatarCompanion.unavailable", "LiveTalking service unavailable")}${error ? ` · ${error}` : ""}`}
              onClick={() => void connect()}
            >
              {tx("avatarCompanion.retry", "Retry")}
            </button>
          ) : null}
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
          <div className={`absolute inset-0 transition-opacity duration-300 ${companionMode === "speaking" && state === "connected" && remoteReady ? "opacity-0" : "opacity-100"}`}>
            {localSources.map((source, index) => source ? (
              <video
                key={index}
                className={`absolute inset-0 h-full w-full object-contain ${fadeLocalSwitch ? "transition-opacity duration-300" : ""} ${activeLocalLayer === index ? "opacity-100" : "opacity-0"}`}
                src={source}
                autoPlay
                muted
                loop={localVideos[companionMode === "working" ? "working" : "idle"].length === 1}
                playsInline
                onLoadedData={() => finishLocalSwitch(index)}
                onEnded={() => rotateLocalVideo(index)}
              />
            ) : null)}
          </div>
          <video
            ref={videoRef}
            className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${companionMode === "speaking" && state === "connected" && remoteReady ? "opacity-100" : "opacity-0"}`}
            autoPlay
            playsInline
            onPlaying={() => setRemoteReady(true)}
          />
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
