import type { DesktopVoiceApi } from "./runtime";

export interface VoiceEvent {
  event: "voice";
  chat_id: string;
  turn_id: string;
  phase: "start" | "chunk" | "end" | "error";
  pcm?: string;
  sequence?: number;
}

export function isVoiceEvent(value: unknown): value is VoiceEvent {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.event === "voice" && typeof data.chat_id === "string"
    && typeof data.turn_id === "string" && ["start", "chunk", "end", "error"].includes(String(data.phase))
    && (data.phase !== "chunk" || (typeof data.pcm === "string" && data.pcm.length <= 8 * 1024 * 1024
      && Number.isSafeInteger(data.sequence) && Number(data.sequence) >= 0));
}

export class VoicePlayer {
  private context: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private audio: HTMLAudioElement | null = null;
  private nextTime = 0;
  private turn = "";
  private sequence = 0;
  private generation = 0;
  private receiving = false;
  private chain = Promise.resolve();
  private mediaActive = false;
  private mediaTransition = Promise.resolve();
  constructor(private host: DesktopVoiceApi, private changed: (turn: string, error?: string) => void) {}

  private setMediaActive(active: boolean): Promise<void> {
    if (active === this.mediaActive) return this.mediaTransition;
    this.mediaActive = active;
    this.mediaTransition = this.mediaTransition.then(() => this.host.active(active)).catch(() => {});
    return this.mediaTransition;
  }

  stop() {
    this.generation++;
    this.receiving = false;
    for (const source of this.sources) { source.onended = null; source.stop(); }
    this.sources.clear();
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); this.audio.src = ""; this.audio = null; }
    if (this.context) { void this.context.close(); this.context = null; }
    this.nextTime = 0;
    this.turn = "";
    this.changed("");
    void this.setMediaActive(false);
  }

  receive(event: VoiceEvent) {
    const version = this.generation;
    this.chain = this.chain.then(async () => {
      if (version !== this.generation) return;
      if (event.phase === "start") {
        if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); this.audio.src = ""; this.audio = null; }
        // 服务端串行合成，下一轮开始时仍把音频排在上一轮之后。
        this.turn = event.turn_id; this.sequence = 0; this.receiving = true;
        this.changed(this.turn);
        return;
      }
      if (event.turn_id !== this.turn) return;
      if (event.phase === "error") throw new Error("语音合成失败，可继续查看文字回复");
      if (event.phase === "end") { this.receiving = false; this.finish(); return; }
      if (event.sequence !== this.sequence++) throw new Error("语音片段不完整");
      const raw = atob(event.pcm!);
      if (!raw.length || raw.length % 2) throw new Error("无效语音片段");
      const context = this.context ??= new AudioContext({ sampleRate: 24000 });
      await context.resume();
      await this.setMediaActive(true);
      if (version !== this.generation) return;
      if (context.state !== "running") throw new Error("自动播放受限，请使用重播按钮");
      const buffer = context.createBuffer(1, raw.length / 2, 24000);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index++) {
        let value = raw.charCodeAt(index * 2) | raw.charCodeAt(index * 2 + 1) << 8;
        if (value >= 32768) value -= 65536;
        samples[index] = value / 32768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer; source.connect(context.destination);
      this.sources.add(source);
      source.onended = () => { this.sources.delete(source); this.finish(); };
      this.nextTime = Math.max(this.nextTime, context.currentTime + 0.03);
      source.start(this.nextTime); this.nextTime += buffer.duration;
    }).catch((error: unknown) => {
      if (version !== this.generation) return;
      this.stop(); this.changed("", error instanceof Error ? error.message : "语音播放失败");
    });
  }

  private finish() {
    if (!this.receiving && this.sources.size === 0) {
      this.turn = ""; this.changed("");
      void this.setMediaActive(false);
    }
  }

  async replay(turn: string, url: string) {
    this.stop();
    const version = this.generation;
    this.turn = turn; this.changed(turn);
    const audio = this.audio = new Audio(url);
    audio.onended = () => this.stop();
    audio.onerror = () => { this.stop(); this.changed("", "语音播放失败"); };
    try {
      await this.setMediaActive(true);
      if (version !== this.generation || this.audio !== audio) return;
      await audio.play();
    } catch {
      if (version === this.generation && this.audio === audio) { this.stop(); this.changed("", "语音播放失败，请重试"); }
    }
  }
}
