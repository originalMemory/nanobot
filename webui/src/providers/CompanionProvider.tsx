import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent } from "react";
import { ChevronDown, ChevronUp, RefreshCw, X, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useClient } from "./ClientProvider";
import { getRuntimeHost, type CompanionPack, type CompanionPrefs, type CompanionVideos, type CompanionApi } from "@/lib/runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleButton } from "@/components/settings/ToggleButton";
import { SettingsGroup, SettingsRow, SettingsSectionTitle, RestartSettingsFooter } from "@/components/settings/shared/SettingsControls";

type Mode = "idle" | "working";
type Panel = CompanionPrefs["panel"];
const Context = createContext<{ api: CompanionApi; prefs: CompanionPrefs | null; videos: CompanionVideos | null; saving: boolean; error: boolean; save: (patch: Partial<CompanionPrefs>) => Promise<boolean>; reload: () => void } | null>(null);

export function clampCompanionPanel(
  panel: Panel,
  width: number,
  height: number,
  minX = 0,
  aspectRatio = 4 / 3,
): Panel {
  const availableWidth = Math.max(1, width - minX);
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 4 / 3;
  const limit = Math.max(1, Math.min(1120, availableWidth, panel.collapsed ? 1120 : (height - 70) * ratio));
  const size = Math.min(limit, Math.max(200, Math.round(panel.width)));
  const panelHeight = panel.collapsed ? 32 : size / ratio + 32;
  return { ...panel, width: size,
    x: Math.max(minX, Math.min(width - size, panel.x ?? width - size - 24)),
    y: Math.max(30, Math.min(height - panelHeight - 8, panel.y ?? height - panelHeight - 24)) };
}

export function pickCompanionVideo(pool: string[], recent: string[], current: string): string {
  const different = pool.filter(url => url !== current);
  const candidates = different.filter(url => !recent.includes(url));
  const available = candidates.length ? candidates : different.length ? different : pool;
  return available[Math.floor(Math.random() * available.length)] ?? "";
}

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [api] = useState(() => getRuntimeHost().companion);
  const [prefs, setPrefs] = useState<CompanionPrefs | null>(null);
  const [videos, setVideos] = useState<CompanionVideos | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [working, setWorking] = useState(false);
  const { client } = useClient();
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.read().then(value => { if (!cancelled) { setPrefs(value); setError(false); } }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [api, revision]);
  useEffect(() => api?.onChanged?.(setPrefs), [api]);
  useEffect(() => { void api?.setWorking?.(working); }, [api, working]);
  useEffect(() => {
    if (!api || !prefs?.enabled) return;
    let cancelled = false;
    const refresh = () => { void api.videos().then(value => { if (!cancelled) setVideos(value); }).catch(() => { if (!cancelled) setError(true); }); };
    refresh(); const timer = window.setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, prefs?.enabled, prefs?.directory, prefs?.scene, prefs?.schedule, revision]);
  useEffect(() => {
    if (!api) return;
    const runs = new Set<string>();
    let unifiedWorking = false;
    const offRun = client.onRunStatus((id, started) => { if (started === null) runs.delete(id); else runs.add(id); setWorking(unifiedWorking || runs.size > 0); });
    const offCompanion = client.onCompanionState(value => { unifiedWorking = value; setWorking(value || runs.size > 0); });
    const offStatus = client.onStatus(status => { if (status !== "open") { runs.clear(); unifiedWorking = false; setWorking(false); } });
    return () => { offRun(); offCompanion(); offStatus(); };
  }, [api, client]);
  const save = useCallback(async (patch: Partial<CompanionPrefs>) => {
    if (!api) return false;
    setSaving(true); setError(false);
    try { setPrefs(await api.save(patch)); return true; }
    catch { setError(true); return false; }
    finally { setSaving(false); }
  }, [api]);
  if (!api) return <>{children}</>;
  return <Context.Provider value={{ api, prefs, videos, saving, error, save, reload: () => setRevision(v => v + 1) }}>
    {children}
    {prefs?.enabled && !prefs.detached && <CompanionPanel api={api} prefs={prefs} videos={videos} mode={working ? "working" : "idle"} save={save} />}
  </Context.Provider>;
}

export function CompanionVideo({ videos, mode, onAspectRatio, onActionChange }: {
  videos: CompanionVideos;
  mode: Mode;
  onAspectRatio: (ratio: number) => void;
  onActionChange: (action: string) => void;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<[string, string]>(["", ""]);
  const [loadVersions, setLoadVersions] = useState([0, 0]);
  const [active, setActive] = useState(0);
  const [fade, setFade] = useState(false);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loop, setLoop] = useState(false);
  const bad = useRef(new Set<string>());
  const recent = useRef<string[]>([]);
  const current = useRef("");
  const ended = useRef(false);
  const activeLayer = useRef(0);
  const previousMode = useRef<Mode | null>(null);
  const pending = useRef<{ layer: number; url: string; fade: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signature = JSON.stringify([videos[mode], videos.fallback[mode], videos.labels]);
  useEffect(() => { bad.current.clear(); }, [signature]);
  useEffect(() => () => onActionChange(""), [onActionChange]);
  useEffect(() => {
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);
    const [pool, fallback, labels] = JSON.parse(signature) as [string[], string[], Record<string, string>];
    let candidates = pool.filter(url => !bad.current.has(url));
    if (!candidates.length) candidates = fallback.filter(url => !bad.current.has(url));
    setLoop(candidates.length === 1);
    const url = pickCompanionVideo(candidates, recent.current, current.current);
    if (!url) { setFailed(true); onActionChange(""); return; }
    setFailed(false);
    if (url === current.current && !ended.current) {
      onActionChange(labels[url] ?? "");
      previousMode.current = mode;
      setFade(false);
      setSources(old => activeLayer.current === 0 ? [old[0], ""] : ["", old[1]]);
      return;
    }
    ended.current = false;
    if (timer.current) clearTimeout(timer.current);
    const layer = activeLayer.current === 0 ? 1 : 0;
    pending.current = { layer, url, fade: previousMode.current !== null && previousMode.current !== mode };
    previousMode.current = mode;
    setLoadVersions(old => old.map((value, index) => index === layer ? value + 1 : value));
    setSources(old => layer === 0 ? [url, old[1]] : [old[0], url]);
  }, [signature, mode, onActionChange, retry]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const ready = (layer: number, url: string, video: HTMLVideoElement) => {
    const next = pending.current;
    if (!next || next.layer !== layer || next.url !== url) return;
    pending.current = null; current.current = url;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      onAspectRatio(video.videoWidth / video.videoHeight);
    }
    recent.current = [...recent.current, url].slice(-3);
    activeLayer.current = layer; setActive(layer); setFade(next.fade);
    onActionChange(videos.labels[url] ?? "");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setSources(old => layer === 0 ? [old[0], ""] : ["", old[1]]); setFade(false); }, next.fade ? 350 : 0);
  };
  return <div className="relative overflow-hidden bg-black/85" style={{ aspectRatio: "var(--companion-aspect-ratio, 4 / 3)" }}>
    {sources.map((url, index) => url && <video key={`${index}:${loadVersions[index]}`} src={url} autoPlay muted playsInline loop={loop}
      className={`absolute inset-0 h-full w-full object-contain ${fade ? "transition-opacity duration-300" : ""} ${active === index ? "opacity-100" : "opacity-0"}`}
      onLoadedData={event => ready(index, url, event.currentTarget)} onEnded={() => { if (index === activeLayer.current) { ended.current = true; setRetry(v => v + 1); } }}
      onError={() => { bad.current.add(url); if (current.current === url) current.current = ""; setRetry(v => v + 1); }} />)}
    {failed && <div role="status" className="absolute inset-0 grid place-content-center bg-muted px-4 text-center text-sm text-muted-foreground">{t("companion.noVideo")}</div>}
  </div>;
}

export function CompanionSceneControls({ prefs, packs, onChange, onSceneOpen }: {
  prefs: CompanionPrefs | null;
  packs: CompanionPack[];
  onChange: (patch: Partial<CompanionPrefs>) => void;
  onSceneOpen: () => void;
}) {
  const { t } = useTranslation();
  const scene = prefs?.directory ? packs.find(pack => pack.id === prefs.scene)?.displayName ?? prefs.scene : t("companion.bundled");
  return <>
    {prefs?.directory ? <Select value={prefs.scene} onValueChange={value => onChange({ scene: value })} onOpenChange={open => { if (open) onSceneOpen(); }}>
      <SelectTrigger className="companion-window-control h-7 min-w-0 max-w-48 border-0 bg-transparent px-1 text-xs" aria-label={t("companion.scene")} title={scene}><SelectValue>{scene}</SelectValue></SelectTrigger>
      <SelectContent className="w-max min-w-0 max-w-[calc(100vw-1rem)]">{packs.map(pack => <SelectItem key={pack.id} value={pack.id}>{pack.displayName}</SelectItem>)}</SelectContent>
    </Select> : <span className="min-w-0 flex-1 truncate text-xs" title={scene}>{scene}</span>}
    <Select value={prefs?.rotationMode ?? "manual"} onValueChange={value => onChange({ rotationMode: value as CompanionPrefs["rotationMode"] })}>
      <SelectTrigger className="companion-window-control h-7 shrink-0 border-0 bg-transparent px-1 text-xs" aria-label={t("companion.rotationMode")}><SelectValue /></SelectTrigger>
      <SelectContent className="w-max min-w-0">{(["manual", "sequential", "random"] as const).map(mode => <SelectItem key={mode} value={mode}>{t(`companion.rotation.${mode}`)}</SelectItem>)}</SelectContent>
    </Select>
  </>;
}

function CompanionPanel({ api, prefs, videos, mode, save }: { api: CompanionApi; prefs: CompanionPrefs; videos: CompanionVideos | null; mode: Mode; save: (patch: Partial<CompanionPrefs>) => Promise<boolean> }) {
  const { t } = useTranslation();
  const [aspectRatio, setAspectRatio] = useState(4 / 3);
  const [action, setAction] = useState("");
  const [packs, setPacks] = useState<CompanionPack[]>([]);
  const refreshPacks = () => { void api.packs(prefs.directory).then(setPacks).catch(() => setPacks([])); };
  useEffect(() => {
    if (!prefs.directory) { setPacks([]); return; }
    let active = true;
    void api.packs(prefs.directory).then(value => { if (active) setPacks(value); })
      .catch(() => { if (active) setPacks([]); });
    return () => { active = false; };
  }, [api, prefs.directory]);
  const clamp = useCallback((value: Panel) => clampCompanionPanel(value, innerWidth, innerHeight,
    document.querySelector<HTMLElement>(".desktop-main")?.getBoundingClientRect().left ?? 0, aspectRatio), [aspectRatio]);
  const [panel, setPanel] = useState(() => clamp(prefs.panel));
  const drag = useRef<{ x: number; y: number; panel: Panel; resize: "left" | "right" | null } | null>(null);
  useEffect(() => { setPanel(clamp(prefs.panel)); }, [clamp, prefs.panel]);
  useEffect(() => { const resize = () => setPanel(value => clamp(value)); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, [clamp]);
  const start = (event: PointerEvent<HTMLElement>, resize: "left" | "right" | null) => {
    if (event.button !== 0 || (!resize && (event.target as HTMLElement).closest("button"))) return;
    drag.current = { x: event.clientX, y: event.clientY, panel, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const persist = (next: Panel) => { next = clamp(next); setPanel(next); void save({ panel: next }); };
  const resizeWithKeyboard = (edge: "left" | "right", delta: number) => {
    const width = panel.width + (edge === "left" ? -delta : delta);
    persist({ ...panel, width, ...(edge === "left" ? { x: (panel.x ?? 0) + panel.width - width } : {}) });
  };
  return <div className="companion-panel fixed z-30 overflow-hidden rounded-lg border border-border/70 bg-transparent shadow-xl" style={{ left: panel.x ?? 0, top: panel.y ?? 30, width: panel.width, "--companion-aspect-ratio": aspectRatio } as CSSProperties}
    onPointerMove={event => { const base = drag.current; if (!base) return; const delta = event.clientX - base.x; const width = base.panel.width + (base.resize === "left" ? -delta : delta); setPanel(clamp({ ...base.panel, ...(base.resize ? { width, ...(base.resize === "left" ? { x: (base.panel.x ?? 0) + base.panel.width - width } : {}) } : { x: (base.panel.x ?? 0) + delta, y: (base.panel.y ?? 0) + event.clientY - base.y }) })); }}
    onPointerUp={() => { if (drag.current) { drag.current = null; void save({ panel }); } }} onPointerCancel={() => { drag.current = null; }}>
    <div className="companion-panel-header flex h-8 touch-none select-none items-center gap-2 bg-background/90 px-2 backdrop-blur cursor-move" tabIndex={0} aria-label={t("companion.move")}
      onPointerDown={event => start(event, null)} onKeyDown={event => { if (event.target !== event.currentTarget || !event.key.startsWith("Arrow")) return; event.preventDefault(); persist({ ...panel, x: (panel.x ?? 0) + (event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0), y: (panel.y ?? 0) + (event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0) }); }}>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" title={t(panel.collapsed ? "companion.expand" : "companion.collapse")} aria-label={t(panel.collapsed ? "companion.expand" : "companion.collapse")} onClick={() => persist({ ...panel, collapsed: !panel.collapsed })}>{panel.collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
        <CompanionSceneControls prefs={prefs} packs={packs} onChange={patch => { void save(patch); }} onSceneOpen={refreshPacks} />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{t(`companion.${mode}`)}{action ? ` · ${action}` : ""}</span>
        <button type="button" title={t("companion.detach")} aria-label={t("companion.detach")} onClick={() => void save({ detached: true })}><ExternalLink size={16} /></button>
        <button type="button" title={t("companion.hide")} aria-label={t("companion.hide")} onClick={() => void save({ enabled: false })}><X size={16} /></button>
      </div>
    </div>
    {!panel.collapsed && <>{videos ? <CompanionVideo videos={videos} mode={mode} onAspectRatio={setAspectRatio} onActionChange={setAction} /> : <div className="bg-muted" style={{ aspectRatio }} />}
      {(["left", "right"] as const).map(edge => <button key={edge} type="button" className={`absolute bottom-0 z-10 h-5 w-5 touch-none bg-transparent ${edge === "left" ? "left-0 cursor-nesw-resize" : "right-0 cursor-nwse-resize"}`} aria-label={t("companion.resize")}
        data-resize-edge={edge} onPointerDown={event => start(event, edge)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); resizeWithKeyboard(edge, event.key === 'ArrowRight' ? 20 : -20); }} />)}
    </>}
  </div>;
}

export function CompanionSettings() {
  const context = useContext(Context); const { t } = useTranslation();
  const [draft, setDraft] = useState<Partial<CompanionPrefs> | null>(null);
  const [chooseError, setChooseError] = useState(false);
  const [packs, setPacks] = useState<CompanionPack[]>([]);
  const [packsLoading, setPacksLoading] = useState(false);
  const [packsRevision, setPacksRevision] = useState(0);
  const api = context?.api;
  const prefs = context?.prefs ?? null;
  const value = prefs && { ...prefs, ...draft };
  const directory = value?.directory ?? "";
  useEffect(() => {
    if (!api || !directory) { setPacks([]); setPacksLoading(false); return; }
    let cancelled = false;
    setPacks([]); setPacksLoading(true); setChooseError(false);
    void api.packs(directory).then(next => {
      if (!cancelled) { setPacks(next); setChooseError(next.length === 0); }
    }).catch(() => { if (!cancelled) { setPacks([]); setChooseError(true); } })
      .finally(() => { if (!cancelled) setPacksLoading(false); });
    return () => { cancelled = true; };
  }, [api, directory, packsRevision, prefs?.scene]);
  if (!context) return null;
  const { saving, error, save, reload, videos } = context;
  if (!value) return <section><SettingsSectionTitle>{t("companion.title")}</SettingsSectionTitle><p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">{t(error ? "companion.error" : "settings.desktop.loading")}</p>{error && <Button size="sm" variant="outline" className="rounded-full" onClick={reload}>{t("settings.desktop.retry")}</Button>}</section>;
  const selectedScene = packs.some(pack => pack.id === value.scene)
    ? value.scene : packs.length === 1 ? packs[0].id : "";
  return <fieldset disabled={saving} className="settings-stack"><section><SettingsSectionTitle>{t("companion.title")}</SettingsSectionTitle>
    <SettingsGroup>
      <SettingsRow title={t("companion.enable")}><ToggleButton checked={prefs?.enabled ?? false} disabled={saving} onChange={enabled => { void save({ enabled }); }} label={t(`settings.values.${prefs?.enabled ? 'on' : 'off'}`)} ariaLabel={t("companion.enable")} /></SettingsRow>
      <SettingsRow title={t("companion.directory")} description={t("companion.directoryHelp")}><div className="min-w-0 space-y-2 text-sm"><p className="break-all text-muted-foreground">{value.directory || t("companion.bundled")}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" className="rounded-full" onClick={() => { setChooseError(false); void context.api.choose().then(nextDirectory => { if (nextDirectory !== null) setDraft({ ...draft, directory: nextDirectory, scene: '' }); }).catch(() => setChooseError(true)); }}>{t("companion.choose")}</Button><Button size="sm" variant="ghost" className="rounded-full" disabled={!value.directory} onClick={() => setDraft({ ...draft, directory: '', scene: '' })}>{t("companion.bundled")}</Button></div></div></SettingsRow>
      {value.directory && <SettingsRow title={t("companion.scene")} description={t("companion.sceneHelp")}><div className="flex min-w-0 items-center gap-2"><Select value={selectedScene} disabled={packsLoading || packs.length === 0} onValueChange={scene => setDraft({ ...draft, scene })}><SelectTrigger className="w-full rounded-full" aria-label={t("companion.scene")}><SelectValue placeholder={t("companion.selectScene")} /></SelectTrigger><SelectContent>{packs.map(pack => <SelectItem key={pack.id} value={pack.id}>{pack.displayName}</SelectItem>)}</SelectContent></Select><Button type="button" size="icon" variant="outline" className="shrink-0 rounded-full" disabled={packsLoading} aria-label={t("companion.refresh")} title={t("companion.refresh")} onClick={() => setPacksRevision(current => current + 1)}><RefreshCw className={`h-4 w-4 ${packsLoading ? "animate-spin" : ""}`} /></Button></div></SettingsRow>}
      {value.directory && <SettingsRow title={t("companion.rotationMode")}><Select value={value.rotationMode} onValueChange={rotationMode => setDraft({ ...draft, rotationMode: rotationMode as CompanionPrefs["rotationMode"] })}><SelectTrigger className="w-44 rounded-full" aria-label={t("companion.rotationMode")}><SelectValue /></SelectTrigger><SelectContent>{(["manual", "sequential", "random"] as const).map(mode => <SelectItem key={mode} value={mode}>{t(`companion.rotation.${mode}`)}</SelectItem>)}</SelectContent></Select></SettingsRow>}
      {value.directory && value.rotationMode !== "manual" && <SettingsRow title={t("companion.rotationHours")}><Input aria-label={t("companion.rotationHours")} type="number" min={0.5} max={168} step={0.5} className="h-9 w-24 rounded-full text-[13px]" value={value.rotationHours} onChange={event => setDraft({ ...draft, rotationHours: Number(event.target.value) })} /></SettingsRow>}
      {Object.entries(value.schedule).map(([period, time]) => <SettingsRow key={period} title={t(`companion.${period}`)}><Input aria-label={t(`companion.${period}`)} type="time" className="h-9 rounded-full text-[13px]" value={time} onChange={event => setDraft({ ...draft, schedule: { ...value.schedule, [period]: event.target.value } })} /></SettingsRow>)}
    </SettingsGroup></section>
    <RestartSettingsFooter dirty={Boolean(draft)} saving={saving} pendingRestart={false} error={error || chooseError || Boolean(videos?.error)} message={error || chooseError ? t("companion.error") : videos?.error ? t("companion.fallback") : undefined}
      disabled={packsLoading || Boolean(value.directory && !selectedScene) || value.rotationHours < 0.5 || value.rotationHours > 168}
      onSave={() => { void save({ ...draft, ...(draft?.directory !== undefined || draft?.scene !== undefined ? { scene: selectedScene } : {}) }).then(ok => { if (ok) setDraft(null); }); }} onReset={() => setDraft(null)} />
  </fieldset>;
}
