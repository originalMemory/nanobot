import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CirclePlay, CircleStop, Square } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient } from "./ClientProvider";
import { getRuntimeHost } from "@/lib/runtime";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleButton } from "@/components/settings/ToggleButton";
import { SettingsGroup, SettingsRow, SettingsSectionTitle, DismissibleStatusMessage, RestartSettingsFooter } from "@/components/settings/shared/SettingsControls";
import { VoicePlayer } from "@/lib/voice";

const VoiceContext = createContext<{ turn: string; available: Set<string>; replay: (turn: string, url?: string) => void; stop: () => void } | null>(null);
export const useVoice = () => useContext(VoiceContext);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { client, getToken } = useClient();
  const [turn, setTurn] = useState("");
  const [error, setError] = useState("");
  const [available, setAvailable] = useState<Set<string>>(() => new Set());
  const player = useRef<VoicePlayer | null>(null);
  const replayVersion = useRef(0);
  const host = getRuntimeHost().voice;
  useEffect(() => {
    if (!host) return;
    const current = new VoicePlayer(host, (id, message) => { setTurn(id); setError(message ?? ""); });
    player.current = current;
    const unsubscribe = client.onVoice((event) => {
      if (event.phase === "start") replayVersion.current++;
      if (event.phase === "end") setAvailable(previous => new Set(previous).add(event.turn_id));
      current.receive(event);
    });
    const status = client.onStatus((value) => { if (value !== "open") { replayVersion.current++; current.stop(); } });
    return () => { replayVersion.current++; unsubscribe(); status(); current.stop(); player.current = null; };
  }, [client, host]);
  const replay = async (id: string, url?: string) => {
    const version = ++replayVersion.current;
    setError("");
    try {
      if (url) { await player.current?.replay(id, url); return; }
      const response = await fetch(`/api/voice/audio?turn_id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!response.ok) throw new Error("无法读取语音");
      const data = await response.json();
      if (version !== replayVersion.current) return;
      if (!data.audio?.url) throw new Error(data.active ? "语音仍在生成" : "此回复没有已保存的语音");
      await player.current?.replay(id, data.audio.url);
    } catch (reason) { if (version === replayVersion.current) setError(reason instanceof Error ? reason.message : "重播失败"); }
  };
  const stop = () => { replayVersion.current++; player.current?.stop(); };
  return <VoiceContext.Provider value={host ? { turn, available, replay: (id, url) => { void replay(id, url); }, stop } : null}>
    {children}
    {error && <div className="fixed bottom-3 right-3 z-50 flex items-center gap-2 rounded-lg border bg-background/85 px-3 py-2 text-sm shadow backdrop-blur">
      <span role="alert">{error}</span>
      <button aria-label="关闭提示" title="关闭提示" onClick={() => setError("")}><Square className="h-4 w-4" /></button>
    </div>}
  </VoiceContext.Provider>;
}

export function VoiceReplayButton({ turnId, audioUrl }: { turnId?: string; audioUrl?: string }) {
  const voice = useContext(VoiceContext);
  if (!voice || !turnId) return null;
  const active = voice.turn === turnId;
  const label = active ? "停止回复语音" : "播放回复语音";
  return <TooltipProvider>
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => active ? voice.stop() : voice.replay(turnId, audioUrl)}>
          {active ? <CircleStop className="h-4 w-4 motion-safe:animate-pulse" aria-hidden /> : <CirclePlay className="h-4 w-4" aria-hidden />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}

interface VoiceSettingsValue {
  preset: string | null;
  voice: string | null;
  presets: { id: string; label: string; voices: { id: string; label: string }[] }[];
}

export function VoiceSettings() {
  const voice = useContext(VoiceContext);
  return voice ? <VoiceSettingsForm /> : null;
}

function VoiceSettingsForm() {
  const { t } = useTranslation();
  const label = (key: string) => t(`settings.aiVoice.${key}`);
  const [saved, setSaved] = useState<{ value: VoiceSettingsValue; pause: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  const { client, getToken } = useClient();
  const host = getRuntimeHost().voice!;
  const [value, setValue] = useState<VoiceSettingsValue | null>(null);
  const [pause, setPause] = useState(true);
  const [support, setSupport] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/voice/settings", { headers: { Authorization: `Bearer ${getToken()}` } }).then(async (r) => { if (!r.ok) throw new Error(); return r.json() as Promise<VoiceSettingsValue>; }),
      host.settings(),
    ]).then(([settings, local]) => { if (!cancelled) { setValue(settings); setPause(local.pauseSystemMedia); setSupport(local.support); setSaved({ value: settings, pause: local.pauseSystemMedia }); } })
      .catch(() => { if (!cancelled) setError("loadError"); });
    return () => { cancelled = true; };
  }, [getToken, host, reload]);
  const save = async () => {
    if (!value) return;
    setBusy(true); setError("");
    try {
      let result = value;
      if (!saved || value.preset !== saved.value.preset || value.voice !== saved.value.voice) {
        result = await client.requestMutation<VoiceSettingsValue>("voice.settings", { preset: value.preset, voice: value.voice });
        setValue(result); setSaved({ value: result, pause: saved?.pause ?? pause });
      }
      if (!saved || pause !== saved.pause) await host.settings(pause);
      setSaved({ value: result, pause });
    } catch { setError("saveError"); }
    finally { setBusy(false); }
  };
  const dirty = Boolean(value && saved && (value.preset !== saved.value.preset || value.voice !== saved.value.voice || pause !== saved.pause));
  return <fieldset className="settings-stack" disabled={busy}>
    <section>
      <SettingsSectionTitle>{label("title")}</SettingsSectionTitle>
      {value ? <SettingsGroup>
        <SettingsRow title={label("provider")} description={label("description")}>
          <Select disabled={busy} value={value.preset ?? ""} onValueChange={(preset) => setValue({ ...value, preset, voice: value.presets.find((p) => p.id === preset)?.voices[0]?.id ?? null })}>
            <SelectTrigger className="w-full rounded-full" aria-label={label("provider")}><SelectValue placeholder={label("selectProvider")} /></SelectTrigger>
            <SelectContent>{value.presets.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow title={label("voice")}>
          <Select disabled={busy || !value.preset} value={value.voice ?? ""} onValueChange={(voice) => setValue({ ...value, voice })}>
            <SelectTrigger className="w-full rounded-full" aria-label={label("voice")}><SelectValue placeholder={label("selectVoice")} /></SelectTrigger>
            <SelectContent>{value.presets.find((p) => p.id === value.preset)?.voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow title={label("pauseMedia")} description={support === "unavailable" ? label("unavailable") : support === "limited" ? label("limited") : label("pauseDescription")}>
          <ToggleButton checked={pause} disabled={busy || support === "unavailable"} onChange={setPause} ariaLabel={label("pauseMedia")} label={t(`settings.values.${pause ? "on" : "off"}`)} />
        </SettingsRow>
      </SettingsGroup> : !error && <p className="text-sm text-muted-foreground">{label("loading")}</p>}
    </section>
    {!value && error && <>
      <DismissibleStatusMessage message={label(error)} isError onDismiss={() => setError("")} />
    </>}
    {!value && <Button size="sm" className="rounded-full" variant="outline" onClick={() => { setError(""); setReload((v) => v + 1); }}>{t("settings.desktop.retry")}</Button>}
    {value && <RestartSettingsFooter dirty={dirty} saving={busy} pendingRestart={false} error={Boolean(error)} message={error ? label(error) : undefined}
      onSave={() => void save()} onReset={() => { if (saved) { setValue(saved.value); setPause(saved.pause); } setError(""); }} /> }
  </fieldset>;
}
