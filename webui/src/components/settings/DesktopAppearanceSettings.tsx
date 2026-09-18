import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow, SettingsSectionTitle } from "@/components/settings/shared/SettingsControls";
import { useDesktopAppearance } from "@/providers/DesktopAppearanceProvider";
import type { DesktopAppearance } from "@/lib/runtime";

export function DesktopAppearanceSettings() {
  const appearance = useDesktopAppearance();
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DesktopAppearance | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!appearance?.api) return null;
  const { api, config } = appearance;
  const value = draft ?? config;
  const label = (key: string) => t(`settings.desktop.${key}`);
  if (!value) return <section>
    {appearance.loadFailed ? <p role="alert">{label("error")}</p> : <p>{label("loading")}</p>}
    {appearance.loadFailed ? <Button variant="outline" onClick={appearance.reload}>{label("retry")}</Button> : null}
  </section>;
  const update = <K extends keyof DesktopAppearance>(key: K, next: DesktopAppearance[K]) => setDraft({ ...value, [key]: next });
  const choose = async (kind: "directory") => {
    setBusy(true); setFailed(false);
    try { const next = await api.choose(kind); if (next !== null) update(kind, next); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setFailed(false);
    try { await appearance.save(value); setDraft(null); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <fieldset disabled={busy} className="space-y-6" data-testid="desktop-appearance-settings">
    <section>
      <SettingsSectionTitle>{label("identity")}</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow title={label("name")}><Input aria-label={label("name")} maxLength={80} value={value.name} onChange={(event) => update("name", event.target.value)} /></SettingsRow>
        <SettingsRow title={label("icon")}><Input aria-label={label("icon")} maxLength={16} value={value.icon} onChange={(event) => update("icon", event.target.value)} /></SettingsRow>
      </SettingsGroup>
    </section>
    <section>
      <SettingsSectionTitle>{label("wallpaper")}</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow title={label("source")}>
          <select className="rounded-control border border-input bg-background p-2 text-foreground" aria-label={label("source")} value={value.source} onChange={(event) => update("source", event.target.value as DesktopAppearance["source"])}>
            {(["none", "url", "directory"] as const).map((source) => <option key={source} value={source}>{label(source)}</option>)}
          </select>
        </SettingsRow>
        {value.source === "url" ? <SettingsRow title={label("url")}><Input aria-label={label("url")} type="url" maxLength={2048} value={value.url} onChange={(event) => update("url", event.target.value)} /></SettingsRow> : null}
        {value.source === "directory" ? <>
          <SettingsRow title={label("directory")}>
            <div className="min-w-0 space-y-2"><p className="break-all text-sm text-muted-foreground">{value.directory}</p><Button variant="outline" onClick={() => void choose("directory")}>{label("choose")}</Button></div>
          </SettingsRow>
          <SettingsRow title={label("order")}>
            <select className="rounded-control border border-input bg-background p-2" aria-label={label("order")} value={value.order} onChange={(event) => update("order", event.target.value as DesktopAppearance["order"])}>
              {(["sequential", "random"] as const).map((order) => <option key={order} value={order}>{label(order)}</option>)}
            </select>
          </SettingsRow>
        </> : null}
        {value.source !== "none" ? <>
          <SettingsRow title={label("interval")}><Input aria-label={label("interval")} type="number" min={1} max={1440} value={value.intervalMinutes} onChange={(event) => update("intervalMinutes", Number(event.target.value))} /></SettingsRow>
          <SettingsRow title={label("opacity")}><div className="flex items-center gap-2"><input aria-label={label("opacity")} type="range" min={50} max={100} value={Math.round(value.opacity * 100)} onChange={(event) => update("opacity", Number(event.target.value) / 100)} /><span>{Math.round(value.opacity * 100)}%</span></div></SettingsRow>
        </> : null}
      </SettingsGroup>
    </section>
    {failed || appearance.wallpaperFailed ? <p role="alert" className="text-sm text-destructive">{label("error")}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => void save()} disabled={!draft || busy}>{t("settings.actions.save")}</Button>
      <Button variant="outline" disabled={!draft || busy} onClick={() => { setDraft(null); setFailed(false); }}>{t("settings.actions.cancel")}</Button>
      {config?.source !== "none" ? <Button variant="outline" onClick={appearance.refreshWallpaper}>{label("next")}</Button> : null}
    </div>
  </fieldset>;
}
