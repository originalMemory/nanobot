import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { ChevronDown, ChevronUp, Maximize2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useClient } from "./ClientProvider";
import { getRuntimeHost, type CompanionPrefs, type CompanionVideos, type CompanionApi } from "@/lib/runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleButton } from "@/components/settings/ToggleButton";
import { SettingsGroup, SettingsRow, SettingsSectionTitle, RestartSettingsFooter } from "@/components/settings/shared/SettingsControls";

type Mode = "idle" | "working";
type Panel = CompanionPrefs["panel"];
const Context = createContext<{ api: CompanionApi; prefs: CompanionPrefs | null; videos: CompanionVideos | null; saving: boolean; error: boolean; save: (patch: Partial<CompanionPrefs>) => Promise<boolean>; reload: () => void } | null>(null);

export function clampCompanionPanel(panel: Panel, width: number, height: number, minX = 0): Panel {
  const availableWidth = Math.max(1, width - minX);
  const limit = Math.max(1, Math.min(1120, availableWidth, panel.collapsed ? 1120 : (height - 78) * 4 / 3));
  const size = Math.min(limit, Math.max(200, Math.round(panel.width)));
  const panelHeight = panel.collapsed ? 32 : size * 3 / 4 + 32;
  return { ...panel, width: size,
    x: Math.max(minX, Math.min(width - size, panel.x ?? width - size - 24)),
    y: Math.max(38, Math.min(height - panelHeight - 8, panel.y ?? height - panelHeight - 24)) };
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
  useEffect(() => {
    if (!api || !prefs?.enabled) return;
    let cancelled = false;
    const refresh = () => { void api.videos().then(value => { if (!cancelled) setVideos(value); }).catch(() => { if (!cancelled) setError(true); }); };
    refresh(); const timer = window.setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, prefs?.enabled, prefs?.directory, prefs?.schedule, revision]);
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
    {prefs?.enabled && <CompanionPanel prefs={prefs} videos={videos} mode={working ? "working" : "idle"} save={save} />}
  </Context.Provider>;
}

function CompanionVideo({ videos, mode }: { videos: CompanionVideos; mode: Mode }) {
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
  const signature = JSON.stringify([videos[mode], videos.fallback[mode]]);
  useEffect(() => { bad.current.clear(); }, [signature]);
  useEffect(() => {
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);
    const [pool, fallback] = JSON.parse(signature) as [string[], string[]];
    let candidates = pool.filter(url => !bad.current.has(url));
    if (!candidates.length) candidates = fallback.filter(url => !bad.current.has(url));
    setLoop(candidates.length === 1);
    const url = pickCompanionVideo(candidates, recent.current, current.current);
    if (!url) { setFailed(true); return; }
    setFailed(false);
    if (url === current.current && !ended.current) {
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
  }, [signature, mode, retry]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const ready = (layer: number, url: string) => {
    const next = pending.current;
    if (!next || next.layer !== layer || next.url !== url) return;
    pending.current = null; current.current = url;
    recent.current = [...recent.current, url].slice(-3);
    activeLayer.current = layer; setActive(layer); setFade(next.fade);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setSources(old => layer === 0 ? [old[0], ""] : ["", old[1]]); setFade(false); }, next.fade ? 350 : 0);
  };
  return <div className="relative aspect-[4/3] overflow-hidden bg-muted">
    {sources.map((url, index) => url && <video key={`${index}:${loadVersions[index]}`} src={url} autoPlay muted playsInline loop={loop}
      className={`absolute inset-0 h-full w-full object-contain ${fade ? "transition-opacity duration-300" : ""} ${active === index ? "opacity-100" : "opacity-0"}`}
      onLoadedData={() => ready(index, url)} onEnded={() => { if (index === activeLayer.current) { ended.current = true; setRetry(v => v + 1); } }}
      onError={() => { bad.current.add(url); if (current.current === url) current.current = ""; setRetry(v => v + 1); }} />)}
    {failed && <div role="status" className="absolute inset-0 grid place-content-center bg-muted px-4 text-center text-sm text-muted-foreground">{t("companion.noVideo")}</div>}
  </div>;
}

function CompanionPanel({ prefs, videos, mode, save }: { prefs: CompanionPrefs; videos: CompanionVideos | null; mode: Mode; save: (patch: Partial<CompanionPrefs>) => Promise<boolean> }) {
  const { t } = useTranslation();
  const clamp = useCallback((value: Panel) => clampCompanionPanel(value, innerWidth, innerHeight,
    document.querySelector<HTMLElement>(".desktop-main")?.getBoundingClientRect().left ?? 0), []);
  const [panel, setPanel] = useState(() => clamp(prefs.panel));
  const drag = useRef<{ x: number; y: number; panel: Panel; resize: boolean } | null>(null);
  useEffect(() => { setPanel(clamp(prefs.panel)); }, [clamp, prefs.panel]);
  useEffect(() => { const resize = () => setPanel(value => clamp(value)); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, [clamp]);
  const start = (event: PointerEvent<HTMLElement>, resize: boolean) => {
    if (event.button !== 0 || (!resize && (event.target as HTMLElement).closest("button"))) return;
    drag.current = { x: event.clientX, y: event.clientY, panel, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const persist = (next: Panel) => { next = clamp(next); setPanel(next); void save({ panel: next }); };
  return <div className="companion-panel fixed z-30 overflow-hidden rounded-2xl border border-border/70 bg-transparent shadow-xl" style={{ left: panel.x ?? 0, top: panel.y ?? 38, width: panel.width }}
    onPointerMove={event => { const base = drag.current; if (!base) return; setPanel(clamp({ ...base.panel, ...(base.resize ? { width: base.panel.width + event.clientX - base.x } : { x: (base.panel.x ?? 0) + event.clientX - base.x, y: (base.panel.y ?? 0) + event.clientY - base.y }) })); }}
    onPointerUp={() => { if (drag.current) { drag.current = null; void save({ panel }); } }} onPointerCancel={() => { drag.current = null; }}>
    <div className="companion-panel-header flex h-8 touch-none select-none items-center justify-between bg-background/90 px-2 backdrop-blur cursor-move" tabIndex={0} aria-label={t("companion.move")}
      onPointerDown={event => start(event, false)} onKeyDown={event => { if (event.target !== event.currentTarget || !event.key.startsWith("Arrow")) return; event.preventDefault(); persist({ ...panel, x: (panel.x ?? 0) + (event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0), y: (panel.y ?? 0) + (event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0) }); }}>
      <button type="button" title={t(panel.collapsed ? "companion.expand" : "companion.collapse")} aria-label={t(panel.collapsed ? "companion.expand" : "companion.collapse")} onClick={() => persist({ ...panel, collapsed: !panel.collapsed })}>{panel.collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
      <span className="text-xs text-muted-foreground">{t(`companion.${mode}`)}</span>
      <button type="button" title={t("companion.hide")} aria-label={t("companion.hide")} onClick={() => void save({ enabled: false })}><X size={16} /></button>
    </div>
    {!panel.collapsed && <>{videos ? <CompanionVideo videos={videos} mode={mode} /> : <div className="aspect-[4/3] bg-muted" />}
      <button type="button" className="absolute bottom-0 right-0 flex h-6 w-6 touch-none cursor-nwse-resize items-center justify-center rounded-tl bg-background/50" aria-label={t("companion.resize")} title={t("companion.resize")}
        onPointerDown={event => start(event, true)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); persist({ ...panel, width: panel.width + (event.key === 'ArrowRight' ? 20 : -20) }); }}><Maximize2 size={12} /></button>
    </>}
  </div>;
}

export function CompanionSettings() {
  const context = useContext(Context); const { t } = useTranslation();
  const [draft, setDraft] = useState<CompanionPrefs | null>(null);
  const [chooseError, setChooseError] = useState(false);
  if (!context) return null;
  const { prefs, api, saving, error, save, reload, videos } = context;
  const value = draft ?? prefs;
  if (!value) return <section><SettingsSectionTitle>{t("companion.title")}</SettingsSectionTitle><p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">{t(error ? "companion.error" : "settings.desktop.loading")}</p>{error && <Button size="sm" variant="outline" className="rounded-full" onClick={reload}>{t("settings.desktop.retry")}</Button>}</section>;
  return <fieldset disabled={saving} className="settings-stack"><section><SettingsSectionTitle>{t("companion.title")}</SettingsSectionTitle>
    <SettingsGroup>
      <SettingsRow title={t("companion.enable")}><ToggleButton checked={prefs?.enabled ?? false} disabled={saving} onChange={enabled => { void save({ enabled }); }} label={t(`settings.values.${prefs?.enabled ? 'on' : 'off'}`)} ariaLabel={t("companion.enable")} /></SettingsRow>
      <SettingsRow title={t("companion.directory")} description={t("companion.directoryHelp")}><div className="min-w-0 space-y-2 text-sm"><p className="break-all text-muted-foreground">{value.directory || t("companion.bundled")}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" className="rounded-full" onClick={() => { setChooseError(false); void api.choose().then(directory => { if (directory !== null) setDraft({ ...value, directory }); }).catch(() => setChooseError(true)); }}>{t("companion.choose")}</Button><Button size="sm" variant="ghost" className="rounded-full" disabled={!value.directory} onClick={() => setDraft({ ...value, directory: '' })}>{t("companion.bundled")}</Button></div></div></SettingsRow>
      {Object.entries(value.schedule).map(([period, time]) => <SettingsRow key={period} title={t(`companion.${period}`)}><Input aria-label={t(`companion.${period}`)} type="time" className="h-9 rounded-full text-[13px]" value={time} onChange={event => setDraft({ ...value, schedule: { ...value.schedule, [period]: event.target.value } })} /></SettingsRow>)}
    </SettingsGroup></section>
    <RestartSettingsFooter dirty={Boolean(draft)} saving={saving} pendingRestart={false} error={error || chooseError || Boolean(videos?.error)} message={error || chooseError ? t("companion.error") : videos?.error ? t("companion.fallback") : undefined}
      onSave={() => { void save({ directory: value.directory, schedule: value.schedule }).then(ok => { if (ok) setDraft(null); }); }} onReset={() => setDraft(null)} />
  </fieldset>;
}
