import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";
import { ExternalLink, Pin, PinOff, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { initializeI18n } from "./i18n";
import { CompanionSceneControls, CompanionVideo } from "./providers/CompanionProvider";
import type { CompanionPack, CompanionPrefs, CompanionVideos } from "./lib/runtime";
import "./globals.css";

interface CompanionWindowApi {
  read(): Promise<CompanionPrefs>;
  videos(): Promise<CompanionVideos>;
  packs(directory: string): Promise<CompanionPack[]>;
  save(patch: Partial<CompanionPrefs>): Promise<CompanionPrefs>;
  setAspectRatio(ratio: number): Promise<void>;
  onWorking(listener: (working: boolean) => void): () => void;
  onChanged(listener: (prefs: CompanionPrefs) => void): () => void;
}

declare global { interface Window { companionWindow: CompanionWindowApi } }

export function DetachedCompanion() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<CompanionPrefs | null>(null);
  const [videos, setVideos] = useState<CompanionVideos | null>(null);
  const [working, setWorking] = useState(false);
  const [action, setAction] = useState("");
  const [packs, setPacks] = useState<CompanionPack[]>([]);
  const refreshPacks = () => { if (prefs?.directory) void window.companionWindow.packs(prefs.directory).then(setPacks).catch(() => setPacks([])); };
  useEffect(() => {
    let active = true;
    void window.companionWindow.read().then(value => { if (active) setPrefs(value); });
    const offPrefs = window.companionWindow.onChanged(setPrefs);
    const offWorking = window.companionWindow.onWorking(setWorking);
    return () => { active = false; offPrefs(); offWorking(); };
  }, []);
  useEffect(() => {
    if (!prefs?.directory) { setPacks([]); return; }
    let active = true;
    void window.companionWindow.packs(prefs.directory)
      .then(value => { if (active) setPacks(value); })
      .catch(() => { if (active) setPacks([]); });
    return () => { active = false; };
  }, [prefs?.directory]);
  useEffect(() => {
    if (!prefs?.enabled) return;
    let active = true;
    const refresh = () => { void window.companionWindow.videos().then(value => { if (active) setVideos(value); }); };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [prefs?.enabled, prefs?.directory, prefs?.scene]);
  const save = (patch: Partial<CompanionPrefs>) => { void window.companionWindow.save(patch).then(setPrefs); };
  return <div className="h-screen overflow-hidden bg-background text-foreground">
    <div className="companion-window-header flex h-8 select-none items-center gap-2 bg-background/90 px-2 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <CompanionSceneControls prefs={prefs} packs={packs} onChange={save} onSceneOpen={refreshPacks} />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{t(working ? "companion.working" : "companion.idle")}{action ? ` · ${action}` : ""}</span>
        <button type="button" className="companion-window-control" title={t("companion.dock")} aria-label={t("companion.dock")} onClick={() => save({ detached: false })}><ExternalLink size={16} /></button>
        <button type="button" className="companion-window-control" title={t(prefs?.pinned ? "companion.unpin" : "companion.pin")} aria-label={t(prefs?.pinned ? "companion.unpin" : "companion.pin")} onClick={() => save({ pinned: !prefs?.pinned })}>{prefs?.pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
        <button type="button" className="companion-window-control" title={t("companion.hide")} aria-label={t("companion.hide")} onClick={() => save({ enabled: false })}><X size={16} /></button>
      </div>
    </div>
    <div className="detached-companion-video">{videos && <CompanionVideo videos={videos} mode={working ? "working" : "idle"} onAspectRatio={ratio => { void window.companionWindow.setAspectRatio(ratio); }} onActionChange={setAction} />}</div>
  </div>;
}

const root = document.getElementById("root");
if (root) void initializeI18n().then(() => ReactDOM.createRoot(root).render(<DetachedCompanion />));
