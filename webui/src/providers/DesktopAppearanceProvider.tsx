import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getRuntimeHost, type DesktopAppearance, type DesktopAppearanceApi } from "@/lib/runtime";
import { fetchSettings } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface AppearanceContextValue {
  config: DesktopAppearance | null;
  api?: DesktopAppearanceApi;
  loadFailed: boolean;
  wallpaperFailed: boolean;
  save: (value: DesktopAppearance) => Promise<void>;
  reload: () => void;
  refreshWallpaper: () => void;
}
const AppearanceContext = createContext<AppearanceContextValue | null>(null);
export const useDesktopAppearance = () => useContext(AppearanceContext);

export function DesktopAppearanceProvider({ children }: { children: ReactNode }) {
  const { client, getToken } = useClient();
  const [api] = useState(() => getRuntimeHost().appearance);
  const [config, setConfig] = useState<DesktopAppearance | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [wallpaperFailed, setWallpaperFailed] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [reloadId, setReloadId] = useState(0);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void Promise.all([api.read(), fetchSettings(getToken())]).then(([value, settings]) => {
      const runtime = settings.runtime_config ?? {};
      const name = runtime["agents.defaults.bot_name"];
      const icon = runtime["agents.defaults.bot_icon"];
      if (!cancelled) { setConfig({ ...value, name: typeof name === "string" ? name : "nanobot",
        icon: typeof icon === "string" ? icon : "🐈" }); setLoadFailed(false); }
    },
      () => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [api, getToken, reloadId]);
  const source = config?.source;
  const interval = config?.intervalMinutes ?? 5;
  const url = config?.url;
  const directory = config?.directory;
  const order = config?.order;
  useEffect(() => {
    if (!api || !source || source === "none") { setImage(null); setWallpaperFailed(false); return; }
    let cancelled = false; let loading = false;
    const refresh = async () => {
      if (cancelled || loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const next = await api.wallpaper();
        if (!cancelled) { setImage(next); setWallpaperFailed(false); }
      } catch { if (!cancelled) setWallpaperFailed(true); }
      finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), interval * 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [api, source, url, directory, order, interval, revision]);
  useEffect(() => {
    if (!image) return;
    const root = document.documentElement;
    root.dataset.wallpaper = "on";
    root.style.setProperty("--desktop-panel-opacity", String(config?.opacity ?? 0.8));
    return () => { delete root.dataset.wallpaper; root.style.removeProperty("--desktop-panel-opacity"); };
  }, [image, config?.opacity]);
  const save = useCallback(async (value: DesktopAppearance) => {
    if (!api) return;
    const { name, icon, ...localValue } = value;
    const local = await api.save(localValue);
    await client.requestMutation("settings.runtime_config.update", { values: {
      "agents.defaults.bot_name": name,
      "agents.defaults.bot_icon": icon,
    } }, 20_000);
    setConfig({ ...local, name, icon });
  }, [api, client]);
  const context = useMemo(() => ({ config, api, loadFailed, wallpaperFailed, save,
    reload: () => setReloadId((value) => value + 1),
    refreshWallpaper: () => setRevision((value) => value + 1) }), [config, api, loadFailed, wallpaperFailed, save]);
  return <AppearanceContext.Provider value={context}>
    {image ? <div className="desktop-wallpaper" data-testid="desktop-wallpaper" style={{ backgroundImage: `url("${image}")` }} /> : null}
    {children}
  </AppearanceContext.Provider>;
}

export function DesktopIdentity({ compact = false }: { compact?: boolean }) {
  const appearance = useDesktopAppearance();
  const config = appearance?.config;
  const [failedAvatar, setFailedAvatar] = useState(false);
  if (!config) return null;
  return <span className="inline-flex min-w-0 max-w-full items-center gap-2" data-testid="desktop-identity">
    {!failedAvatar
      ? <img src="/api/avatar" alt="" onError={() => setFailedAvatar(true)} className="h-8 w-8 shrink-0 rounded-full object-cover" />
      : <span className="flex h-8 w-8 shrink-0 items-center justify-center text-xl" aria-hidden>{config.icon || config.name.slice(0, 1)}</span>}
    {!compact ? <span className="truncate text-sm font-medium text-foreground">{config.name}</span> : null}
  </span>;
}
