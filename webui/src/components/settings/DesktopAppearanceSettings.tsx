import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { NumberInput, RestartSettingsFooter, SettingsGroup, SettingsRow, SettingsSectionTitle } from "@/components/settings/shared/SettingsControls";
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
    {appearance.loadFailed ? <Button size="sm" className="rounded-full" variant="outline" onClick={appearance.reload}>{label("retry")}</Button> : null}
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
  return <fieldset disabled={busy} className="settings-stack" data-testid="desktop-appearance-settings">
    <section>
      <SettingsSectionTitle>{label("identity")}</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow title={label("name")}><Input className="h-9 rounded-full text-[13px]" aria-label={label("name")} maxLength={80} value={value.name} onChange={(event) => update("name", event.target.value)} /></SettingsRow>
        <SettingsRow title={label("icon")}><Input className="h-9 rounded-full text-[13px]" aria-label={label("icon")} maxLength={16} value={value.icon} onChange={(event) => update("icon", event.target.value)} /></SettingsRow>
      </SettingsGroup>
    </section>
    <section>
      <SettingsSectionTitle>{label("layout")}</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow title={label("contentWidth")}>
          <NumberInput ariaLabel={label("contentWidth")} min={640} max={1440} suffix="px"
            value={value.contentWidth} onChange={(next) => update("contentWidth", next)} />
        </SettingsRow>
      </SettingsGroup>
    </section>
    <section>
      <SettingsSectionTitle>{label("wallpaper")}</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow title={label("source")}>
          <Select disabled={busy} value={value.source} onValueChange={(next) => update("source", next as DesktopAppearance["source"])}>
            <SelectTrigger className="w-full rounded-full" aria-label={label("source")}><SelectValue /></SelectTrigger>
            <SelectContent>{(["none", "url", "directory"] as const).map((source) => <SelectItem key={source} value={source}>{label(source)}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsRow>
        {value.source === "url" ? <SettingsRow title={label("url")}><Input className="h-9 rounded-full text-[13px]" aria-label={label("url")} type="url" maxLength={2048} value={value.url} onChange={(event) => update("url", event.target.value)} /></SettingsRow> : null}
        {value.source === "directory" ? <>
          <SettingsRow title={label("directory")}>
            <div className="min-w-0 space-y-2"><p className="break-all text-sm text-muted-foreground">{value.directory}</p><Button size="sm" className="rounded-full" variant="outline" onClick={() => void choose("directory")}>{label("choose")}</Button></div>
          </SettingsRow>
          <SettingsRow title={label("order")}>
            <Select disabled={busy} value={value.order} onValueChange={(next) => update("order", next as DesktopAppearance["order"])}>
              <SelectTrigger className="w-full rounded-full" aria-label={label("order")}><SelectValue /></SelectTrigger>
              <SelectContent>{(["sequential", "random"] as const).map((order) => <SelectItem key={order} value={order}>{label(order)}</SelectItem>)}</SelectContent>
            </Select>
          </SettingsRow>
        </> : null}
        {value.source !== "none" ? <>
          <SettingsRow title={label("interval")}><NumberInput ariaLabel={label("interval")} min={1} max={1440} value={value.intervalMinutes} onChange={(next) => update("intervalMinutes", next)} /></SettingsRow>
          <SettingsRow title={label("opacity")}><NumberInput ariaLabel={label("opacity")} min={50} max={100} suffix="%" value={Math.round(value.opacity * 100)} onChange={(next) => update("opacity", next / 100)} /></SettingsRow>
        </> : null}
      </SettingsGroup>
    </section>
    {config?.source !== "none" ? <div className="flex justify-end"><Button size="sm" className="rounded-full" variant="ghost" onClick={appearance.refreshWallpaper}>{label("next")}</Button></div> : null}
    <RestartSettingsFooter dirty={Boolean(draft)} saving={busy} pendingRestart={false}
      error={failed || appearance.wallpaperFailed} message={failed || appearance.wallpaperFailed ? label("error") : undefined}
      onSave={() => void save()} onReset={() => { setDraft(null); setFailed(false); }} />
  </fieldset>;
}
