import type { AssistantPlaybackSegment } from "./types";

type QueueKey = string;
type PsbAction = { type: string; payload?: Record<string, unknown> };
type QueuedSegment = { segment: AssistantPlaybackSegment };
type ActiveAudioPlayback = { audio: HTMLAudioElement; stop: () => void };

const queues = new Map<QueueKey, QueuedSegment[]>();
const playing = new Set<QueueKey>();
const nextExpectedIndex = new Map<QueueKey, number>();
const activeAudios = new Map<QueueKey, ActiveAudioPlayback>();
const delegatedUntil = new Map<QueueKey, number>();
const delegatedTimers = new Map<QueueKey, number>();
const listeners = new Set<() => void>();
let stateVersion = 0;

function notifyPlaybackStateChanged(): void {
  stateVersion += 1;
  listeners.forEach((listener) => listener());
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
  const until = Math.max(now, delegatedUntil.get(key) ?? 0) + durationMs;
  delegatedUntil.set(key, until);
  const existing = delegatedTimers.get(key);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  }
  delegatedTimers.set(key, window.setTimeout(() => {
    if ((delegatedUntil.get(key) ?? 0) <= Date.now()) {
      delegatedUntil.delete(key);
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

function playAudio(url: string, key: QueueKey): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

async function consumeSegment(segment: AssistantPlaybackSegment): Promise<void> {
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
  if (delegatedToPsb) {
    markDelegatedPlaybackActive(segment.messageId, estimateSegmentDurationMs(segment));
    return;
  }

  for (const control of segment.controls ?? []) {
    await sendPsbAction(toPsbAction(control));
  }
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
  playing.add(key);
  notifyPlaybackStateChanged();
  try {
    const queue = queues.get(key);
    while (queue && queue.length > 0) {
      queue.sort((a, b) => a.segment.segmentIndex - b.segment.segmentIndex);
      const expected = nextExpectedIndex.get(key) ?? 0;
      if (queue[0]?.segment.segmentIndex !== expected) break;
      const item = queue.shift();
      if (!item) break;
      await consumeSegment(item.segment);
      nextExpectedIndex.set(key, expected + 1);
    }
    if (queue && queue.length === 0) queues.delete(key);
  } finally {
    playing.delete(key);
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
    queues.delete(messageId);
    playing.delete(messageId);
    nextExpectedIndex.delete(messageId);
    stopActiveAudio(messageId);
    clearDelegatedPlayback(messageId);
    notifyPlaybackStateChanged();
    return;
  }
  queues.clear();
  playing.clear();
  nextExpectedIndex.clear();
  stopAllActiveAudios();
  for (const key of delegatedUntil.keys()) {
    clearDelegatedPlayback(key);
  }
  notifyPlaybackStateChanged();
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
  const messageId = playable[0].messageId;
  clearAssistantPlaybackQueues(messageId);
  await sendPsbAction({
    type: "playback-stop",
    payload: { messageId },
  });
  playable.forEach(enqueueAssistantPlaybackSegment);
}
