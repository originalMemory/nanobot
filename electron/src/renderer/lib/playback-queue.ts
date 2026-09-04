import type {
  AssistantAudioChunk,
  AssistantAudioStart,
  AssistantPlaybackSegment,
  AssistantSpeech,
} from "./types";
import {
  finishLivetalkingStream,
  disconnectLivetalking,
  interruptLivetalking,
  isAvatarCompanionAudioActive,
  waitForLivetalkingSilence,
  sendLivetalkingChunk,
  startLivetalkingStream,
} from "./livetalking-bridge";

type QueueKey = string;
type PsbAction = { type: string; payload?: Record<string, unknown> };
type QueuedSegment = { segment: AssistantPlaybackSegment };
type ActiveAudioPlayback = { audio: HTMLAudioElement; stop: () => void };
type ExternallyOwnedStream = { startedAtMs: number; cleanupTimer: number | null };
type StreamingAudio = {
  audioId: string;
  sampleRate: number;
  expectedSequence: number;
  buffered: Array<{ pcm: Uint8Array; data: string }>;
  bufferedSeconds: number;
  delegated: boolean | null;
  livetalking: boolean;
  activated: boolean;
  activatedAtMs: number | null;
  activation: Promise<void> | null;
  deliveryChain: Promise<void>;
  context: AudioContext | null;
  nextStartTime: number;
  sources: AudioBufferSourceNode[];
  cleanupTimer: number | null;
};

const queues = new Map<QueueKey, QueuedSegment[]>();
const playing = new Set<QueueKey>();
const queueGenerations = new Map<QueueKey, number>();
const localPlaybackDrains = new Set<QueueKey>();
const nextExpectedIndex = new Map<QueueKey, number>();
const activeAudios = new Map<QueueKey, ActiveAudioPlayback>();
const delegatedUntil = new Map<QueueKey, number>();
const delegatedStartedAt = new Map<QueueKey, number>();
const delegatedTimers = new Map<QueueKey, number>();
const listeners = new Set<() => void>();
const streams = new Map<string, StreamingAudio>();
const externallyOwnedStreams = new Map<string, ExternallyOwnedStream>();
let stateVersion = 0;
let systemMediaActive = false;
let systemMediaTransition = Promise.resolve();

function setSystemMediaPlaybackActive(active: boolean): Promise<void> {
  if (active === systemMediaActive) return systemMediaTransition;
  systemMediaActive = active;
  const api = window.electronAPI?.systemMedia;
  if (!api?.setTtsActive) return systemMediaTransition;
  systemMediaTransition = systemMediaTransition
    .then(() => api.setTtsActive(active))
    .catch((): void => undefined);
  return systemMediaTransition;
}

function notifyPlaybackStateChanged(): void {
  stateVersion += 1;
  listeners.forEach((listener) => listener());
  const active = hasAudibleAssistantPlayback();
  if (active === systemMediaActive) return;
  void setSystemMediaPlaybackActive(active);
}

export function subscribeAssistantPlayback(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAssistantPlaybackVersion(): number {
  return stateVersion;
}

function estimateSegmentDurationMs(segment: AssistantPlaybackSegment): number {
  const text = String(segment.rawText || "").replace(/<[^>]+>/g, "").trim();
  return Math.max(1200, Math.min(12_000, 600 + text.length * 180));
}

function markDelegatedPlaybackActive(key: QueueKey, durationMs: number): void {
  const now = Date.now();
  if ((delegatedUntil.get(key) ?? 0) <= now) delegatedStartedAt.set(key, now);
  const until = Math.max(now, delegatedUntil.get(key) ?? 0) + durationMs;
  delegatedUntil.set(key, until);
  const existing = delegatedTimers.get(key);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  }
  delegatedTimers.set(key, window.setTimeout(() => {
    if ((delegatedUntil.get(key) ?? 0) <= Date.now()) {
      delegatedUntil.delete(key);
      delegatedStartedAt.delete(key);
      delegatedTimers.delete(key);
      notifyPlaybackStateChanged();
    }
  }, Math.max(0, until - now)));
  notifyPlaybackStateChanged();
}

function clearDelegatedPlayback(key: QueueKey): void {
  const timer = delegatedTimers.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
  }
  delegatedTimers.delete(key);
  delegatedUntil.delete(key);
  delegatedStartedAt.delete(key);
}

function toPsbAction(control: { type: string; payload?: Record<string, unknown> }): PsbAction {
  return {
    type: control.type,
    payload: control.payload ?? {},
  };
}

function toPsbSegmentAudioAction(segment: AssistantPlaybackSegment): PsbAction {
  return {
    type: "segment-audio",
    payload: {
      messageId: segment.messageId,
      segmentIndex: segment.segmentIndex,
      url: segment.audio?.url,
      mimeType: segment.audio?.mimeType,
      controls: (segment.controls ?? []).map(toPsbAction),
    },
  };
}

async function sendPsbAction(action: PsbAction): Promise<boolean> {
  const api = window.electronAPI?.psb;
  if (!api?.sendAction) return false;
  try {
    const result = await api.sendAction(action);
    return result?.ok === true;
  } catch {
    return false;
  }
}

function decodeBase64Pcm(data: string): Uint8Array {
  const raw = window.atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function pcmToAudioBuffer(context: AudioContext, pcm: Uint8Array, sampleRate: number): AudioBuffer {
  const samples = Math.floor(pcm.byteLength / 2);
  const buffer = context.createBuffer(1, samples, sampleRate);
  const output = buffer.getChannelData(0);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index < samples; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 32768;
  }
  return buffer;
}

function scheduleLocalChunk(stream: StreamingAudio, pcm: Uint8Array): void {
  const context = stream.context;
  if (!context) return;
  const source = context.createBufferSource();
  source.buffer = pcmToAudioBuffer(context, pcm, stream.sampleRate);
  source.connect(context.destination);
  const startsAt = Math.max(context.currentTime + 0.03, stream.nextStartTime);
  source.start(startsAt);
  stream.nextStartTime = startsAt + source.buffer.duration;
  stream.sources.push(source);
}

function queueDelegatedChunk(stream: StreamingAudio, data: string): void {
  stream.deliveryChain = stream.deliveryChain.then(async () => {
    if (streams.get(stream.audioId) !== stream) return;
    await sendPsbAction({
      type: "audio-stream-chunk",
      payload: {
        audioId: stream.audioId,
        data,
        sampleRate: stream.sampleRate,
      },
    });
  });
}

function activateStream(stream: StreamingAudio): Promise<void> {
  if (stream.activation) return stream.activation;
  stream.activation = (async () => {
    try {
      // 委托优先级: LiveTalking 数字伴侣 > psb 桌宠 > 本地播放
      stream.livetalking = await startLivetalkingStream(stream.audioId, stream.sampleRate);
      stream.delegated = stream.livetalking;
      if (!stream.delegated) {
        stream.delegated = await sendPsbAction({
          type: "audio-stream-start",
          payload: { audioId: stream.audioId, sampleRate: stream.sampleRate },
        });
      }
      if (streams.get(stream.audioId) !== stream) {
        if (stream.livetalking) {
          await finishLivetalkingStream();
          disconnectLivetalking();
        } else if (stream.delegated) {
          await sendPsbAction({ type: "audio-stream-stop", payload: { audioId: stream.audioId } });
        }
        return;
      }
      if (!stream.delegated || stream.livetalking) {
        await setSystemMediaPlaybackActive(true);
        if (streams.get(stream.audioId) !== stream) {
          if (stream.livetalking) {
            await finishLivetalkingStream();
            disconnectLivetalking();
          }
          notifyPlaybackStateChanged();
          return;
        }
      }
      if (!stream.delegated) {
        stream.context = new AudioContext({ sampleRate: stream.sampleRate });
        if (stream.context.state === "suspended") await stream.context.resume();
        stream.nextStartTime = stream.context.currentTime + 0.03;
      }
      stream.activatedAtMs = Date.now();
      const chunks = stream.buffered.splice(0);
      for (const chunk of chunks) {
        if (stream.delegated && isAvatarCompanionAudioActive()) {
          await sendLivetalkingChunk(chunk.data);
        } else if (stream.delegated) {
          queueDelegatedChunk(stream, chunk.data);
        } else {
          scheduleLocalChunk(stream, chunk.pcm);
        }
      }
      stream.activated = true;
      notifyPlaybackStateChanged();
    } catch {
      stopStreamingAudio(stream.audioId);
    }
  })();
  return stream.activation;
}

function stopStreamingAudio(audioId: string): void {
  const stream = streams.get(audioId);
  if (!stream) return;
  if (stream.cleanupTimer !== null) window.clearTimeout(stream.cleanupTimer);
  stream.sources.forEach((source) => {
    try { source.stop(); } catch { /* already ended */ }
  });
  if (stream.context) void stream.context.close();
  if (stream.livetalking && isAvatarCompanionAudioActive()) {
    void finishLivetalkingStream();
    void interruptLivetalking();
    disconnectLivetalking();
  } else if (stream.livetalking) {
    disconnectLivetalking();
  } else if (stream.delegated) {
    void sendPsbAction({ type: "audio-stream-stop", payload: { audioId } });
  }
  streams.delete(audioId);
  notifyPlaybackStateChanged();
}

export function startAssistantAudioStream(audio: AssistantAudioStart): void {
  const hadPlayback = hasAnyAssistantPlayback();
  clearAssistantPlaybackQueues();
  if (hadPlayback) void sendPsbAction({ type: "playback-stop", payload: {} });
  if (audio.owner === "tha") {
    externallyOwnedStreams.set(audio.audioId, {
      startedAtMs: Date.now(),
      cleanupTimer: null,
    });
    notifyPlaybackStateChanged();
    return;
  }
  streams.set(audio.audioId, {
    audioId: audio.audioId,
    sampleRate: audio.sampleRate,
    expectedSequence: 0,
    buffered: [],
    bufferedSeconds: 0,
    delegated: null,
    livetalking: false,
    activated: false,
    activatedAtMs: null,
    activation: null,
    deliveryChain: Promise.resolve(),
    context: null,
    nextStartTime: 0,
    sources: [],
    cleanupTimer: null,
  });
  for (const control of audio.controls ?? []) void sendPsbAction(toPsbAction(control));
  notifyPlaybackStateChanged();
}

export function appendAssistantAudioChunk(audio: AssistantAudioChunk): void {
  if (externallyOwnedStreams.has(audio.audioId)) return;
  const stream = streams.get(audio.audioId);
  if (!stream || audio.sequence !== stream.expectedSequence) {
    if (stream) stopStreamingAudio(audio.audioId);
    return;
  }
  stream.expectedSequence += 1;
  let pcm: Uint8Array;
  try {
    pcm = decodeBase64Pcm(audio.data);
  } catch {
    stopStreamingAudio(audio.audioId);
    return;
  }
  stream.bufferedSeconds += pcm.byteLength / (stream.sampleRate * 2);
  if (!stream.activated) {
    stream.buffered.push({ pcm, data: audio.data });
    if (stream.buffered.length >= 2 || stream.bufferedSeconds >= 1) void activateStream(stream);
    return;
  }
  if (stream.delegated && isAvatarCompanionAudioActive()) {
    stream.deliveryChain = stream.deliveryChain.then(async () => {
      if (streams.get(stream.audioId) !== stream) return;
      const ok = await sendLivetalkingChunk(audio.data);
      if (!ok) {
        // LiveTalking 中途失败: 停止委托，剩余块回退本地播放
        stream.delegated = false;
        stream.livetalking = false;
        disconnectLivetalking();
        stream.context = new AudioContext({ sampleRate: stream.sampleRate });
        stream.nextStartTime = stream.context.currentTime + 0.03;
        scheduleLocalChunk(stream, pcm);
      }
    });
  } else if (stream.delegated) {
    queueDelegatedChunk(stream, audio.data);
  } else {
    scheduleLocalChunk(stream, pcm);
  }
}

export async function finishAssistantAudioStream(audio: AssistantSpeech): Promise<void> {
  const external = externallyOwnedStreams.get(audio.audioId);
  if (external) {
    const remainingMs = Math.max(0, (audio.durationMs ?? 0) - (Date.now() - external.startedAtMs));
    if (remainingMs > 0) {
      external.cleanupTimer = window.setTimeout(() => {
        externallyOwnedStreams.delete(audio.audioId);
        notifyPlaybackStateChanged();
      }, remainingMs + 100);
    } else {
      externallyOwnedStreams.delete(audio.audioId);
      notifyPlaybackStateChanged();
    }
    return;
  }
  const stream = streams.get(audio.audioId);
  if (!stream) return;
  if (!stream.activated) await activateStream(stream);
  if (!streams.has(audio.audioId)) return;
  if (stream.delegated) {
    await stream.deliveryChain;
    if (!streams.has(audio.audioId)) return;
    if (stream.livetalking) {
      await finishLivetalkingStream();
      await waitForLivetalkingSilence(Math.max(30_000, (audio.durationMs ?? 0) + 10_000));
    } else {
      await sendPsbAction({ type: "audio-stream-end", payload: { audioId: stream.audioId } });
    }
  }
  const remainingMs = stream.livetalking
    ? 0
    : stream.context
    ? Math.max(0, (stream.nextStartTime - stream.context.currentTime) * 1000)
    : Math.max(
        0,
        (audio.durationMs ?? 0) - (stream.activatedAtMs ? Date.now() - stream.activatedAtMs : 0),
      );
  stream.cleanupTimer = window.setTimeout(() => stopStreamingAudio(audio.audioId), remainingMs + 100);
}

export function failAssistantAudioStream(audioId: string): void {
  const external = externallyOwnedStreams.get(audioId);
  if (external?.cleanupTimer !== null && external?.cleanupTimer !== undefined) {
    window.clearTimeout(external.cleanupTimer);
  }
  if (externallyOwnedStreams.delete(audioId)) notifyPlaybackStateChanged();
  stopStreamingAudio(audioId);
}

export function isAssistantSpeechActive(audioId: string): boolean {
  return externallyOwnedStreams.has(audioId)
    || streams.has(audioId)
    || activeAudios.has(audioId)
    || delegatedUntil.has(audioId);
}

export function getAssistantSpeechProgress(
  audioId: string,
  totalMs: number,
): { currentMs: number; totalMs: number } {
  const safeTotal = Math.max(0, totalMs);
  const localCurrent = activeAudios.get(audioId)?.audio.currentTime;
  let currentMs = typeof localCurrent === "number" && Number.isFinite(localCurrent)
    ? localCurrent * 1000
    : 0;
  const streamStartedAt = streams.get(audioId)?.activatedAtMs;
  const delegatedAt = delegatedStartedAt.get(audioId);
  const startedAt = streamStartedAt ?? delegatedAt;
  if (startedAt !== undefined && startedAt !== null) {
    currentMs = Math.max(currentMs, Date.now() - startedAt);
  }
  return {
    currentMs: Math.min(safeTotal, Math.max(0, currentMs)),
    totalMs: safeTotal,
  };
}

export async function replayAssistantSpeech(speech: AssistantSpeech): Promise<void> {
  if (!speech.url) return;
  const hadPlayback = hasAnyAssistantPlayback();
  clearAssistantPlaybackQueues();
  if (hadPlayback) await sendPsbAction({ type: "playback-stop", payload: {} });
  const delegated = await sendPsbAction({
    type: "segment-audio",
    payload: {
      messageId: speech.audioId,
      segmentIndex: 0,
      url: speech.url,
      mimeType: speech.mimeType,
      controls: speech.controls ?? [],
    },
  });
  if (delegated) {
    markDelegatedPlaybackActive(speech.audioId, speech.durationMs ?? 12_000);
    return;
  }
  await playAudio(speech.url, speech.audioId);
}

function stopActiveAudio(key: QueueKey): void {
  const playback = activeAudios.get(key);
  if (!playback) return;
  playback.stop();
  activeAudios.delete(key);
  notifyPlaybackStateChanged();
}

function stopAllActiveAudios(): void {
  for (const key of activeAudios.keys()) {
    stopActiveAudio(key);
  }
}

function setActiveAudio(key: QueueKey, playback: ActiveAudioPlayback): void {
  const existing = activeAudios.get(key);
  if (existing) {
    existing.stop();
  }
  activeAudios.set(key, playback);
  notifyPlaybackStateChanged();
}

async function playAudio(url: string, key: QueueKey): Promise<void> {
  await setSystemMediaPlaybackActive(true);
  try {
    await new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    let settled = false;

    const finalize = (error: Error | null = null) => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      activeAudios.delete(key);
      notifyPlaybackStateChanged();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const stop = () => {
      audio.pause();
      audio.currentTime = 0;
      finalize(null);
    };

    setActiveAudio(key, { audio, stop });
    audio.onended = () => finalize(null);
    audio.onerror = () => finalize(new Error("audio_playback_failed"));
    void audio.play().catch((error: unknown) => {
      if (error instanceof Error) {
        finalize(error);
      } else {
        finalize(new Error("audio_playback_failed"));
      }
    });
    });
  } finally {
    notifyPlaybackStateChanged();
  }
}

async function consumeSegment(
  segment: AssistantPlaybackSegment,
  isCurrent: () => boolean,
): Promise<void> {
  if (segment.audio?.status === "failed") {
    await sendPsbAction({
      type: "segment-end",
      payload: { messageId: segment.messageId, segmentIndex: segment.segmentIndex, reason: "failed" },
    });
    return;
  }
  const url = segment.audio?.url;
  if (!url) return;

  const delegatedToPsb = await sendPsbAction(toPsbSegmentAudioAction(segment));
  if (!isCurrent()) return;
  if (delegatedToPsb) {
    markDelegatedPlaybackActive(segment.messageId, estimateSegmentDurationMs(segment));
    return;
  }

  for (const control of segment.controls ?? []) {
    await sendPsbAction(toPsbAction(control));
    if (!isCurrent()) return;
  }
  await setSystemMediaPlaybackActive(true);
  if (!isCurrent()) {
    notifyPlaybackStateChanged();
    return;
  }
  localPlaybackDrains.add(segment.messageId);
  notifyPlaybackStateChanged();
  try {
    await playAudio(url, segment.messageId);
    await sendPsbAction({
      type: "segment-end",
      payload: { messageId: segment.messageId, segmentIndex: segment.segmentIndex, reason: "ended" },
    });
  } catch {
    await sendPsbAction({
      type: "segment-end",
      payload: { messageId: segment.messageId, segmentIndex: segment.segmentIndex, reason: "failed" },
    });
  }
}

async function drainQueue(key: QueueKey): Promise<void> {
  if (playing.has(key)) return;
  const queue = queues.get(key);
  queue?.sort((a, b) => a.segment.segmentIndex - b.segment.segmentIndex);
  const firstExpected = nextExpectedIndex.get(key) ?? 0;
  if (queue?.[0]?.segment.segmentIndex !== firstExpected) return;
  const generation = queueGenerations.get(key) ?? 0;
  playing.add(key);
  notifyPlaybackStateChanged();
  try {
    while (queue && queue.length > 0 && (queueGenerations.get(key) ?? 0) === generation) {
      queue.sort((a, b) => a.segment.segmentIndex - b.segment.segmentIndex);
      const expected = nextExpectedIndex.get(key) ?? 0;
      if (queue[0]?.segment.segmentIndex !== expected) break;
      const item = queue.shift();
      if (!item) break;
      await consumeSegment(
        item.segment,
        () => (queueGenerations.get(key) ?? 0) === generation,
      );
      if ((queueGenerations.get(key) ?? 0) !== generation) break;
      nextExpectedIndex.set(key, expected + 1);
    }
    if (queue && queue.length === 0) queues.delete(key);
  } finally {
    playing.delete(key);
    localPlaybackDrains.delete(key);
    notifyPlaybackStateChanged();
    const queue = queues.get(key);
    const expected = nextExpectedIndex.get(key) ?? 0;
    if (queue?.some((item) => item.segment.segmentIndex === expected)) {
      void drainQueue(key);
    }
  }
}

export function enqueueAssistantPlaybackSegment(segment: AssistantPlaybackSegment): void {
  if (!segment || typeof segment.segmentIndex !== "number") return;
  const key = segment.messageId;
  const queue = queues.get(key) ?? [];
  queue.push({ segment });
  queues.set(key, queue);
  notifyPlaybackStateChanged();
  void drainQueue(key);
}

export function clearAssistantPlaybackQueues(messageId?: string): void {
  if (messageId) {
    stopStreamingAudio(messageId);
    const queue = queues.get(messageId);
    if (queue) queue.length = 0;
    queues.delete(messageId);
    queueGenerations.set(messageId, (queueGenerations.get(messageId) ?? 0) + 1);
    localPlaybackDrains.delete(messageId);
    nextExpectedIndex.delete(messageId);
    stopActiveAudio(messageId);
    clearDelegatedPlayback(messageId);
    const external = externallyOwnedStreams.get(messageId);
    if (external?.cleanupTimer !== null && external?.cleanupTimer !== undefined) {
      window.clearTimeout(external.cleanupTimer);
    }
    externallyOwnedStreams.delete(messageId);
    notifyPlaybackStateChanged();
    return;
  }
  for (const audioId of [...streams.keys()]) stopStreamingAudio(audioId);
  for (const external of externallyOwnedStreams.values()) {
    if (external.cleanupTimer !== null) window.clearTimeout(external.cleanupTimer);
  }
  externallyOwnedStreams.clear();
  for (const [key, queue] of queues) {
    queue.length = 0;
    queueGenerations.set(key, (queueGenerations.get(key) ?? 0) + 1);
  }
  for (const key of playing) {
    queueGenerations.set(key, (queueGenerations.get(key) ?? 0) + 1);
  }
  queues.clear();
  localPlaybackDrains.clear();
  nextExpectedIndex.clear();
  stopAllActiveAudios();
  for (const key of delegatedUntil.keys()) {
    clearDelegatedPlayback(key);
  }
  notifyPlaybackStateChanged();
}

function hasAnyAssistantPlayback(): boolean {
  return streams.size > 0
    || externallyOwnedStreams.size > 0
    || queues.size > 0
    || playing.size > 0
    || activeAudios.size > 0
    || delegatedUntil.size > 0;
}

function hasAudibleAssistantPlayback(): boolean {
  return [...streams.values()].some(
    (stream) => stream.activated && (!stream.delegated || stream.livetalking),
  )
    || localPlaybackDrains.size > 0
    || activeAudios.size > 0;
}

export function stopAssistantPlayback(messageId?: string): void {
  clearAssistantPlaybackQueues(messageId);
  void sendPsbAction({
    type: "playback-stop",
    payload: messageId ? { messageId } : {},
  });
}

export function isAssistantPlaybackActive(messageId: string): boolean {
  return (
    playing.has(messageId)
    || queues.has(messageId)
    || activeAudios.has(messageId)
    || (delegatedUntil.get(messageId) ?? 0) > Date.now()
  );
}

export async function replayAssistantPlaybackSegments(
  segments: AssistantPlaybackSegment[],
): Promise<void> {
  const playable = segments
    .filter((segment) => segment.audio?.status === "ready" && !!segment.audio.url)
    .sort((a, b) => a.segmentIndex - b.segmentIndex);
  if (playable.length === 0) return;
  clearAssistantPlaybackQueues();
  await sendPsbAction({
    type: "playback-stop",
    payload: {},
  });
  playable.forEach(enqueueAssistantPlaybackSegment);
}
