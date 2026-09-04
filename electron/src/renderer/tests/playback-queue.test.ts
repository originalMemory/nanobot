import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAssistantPlaybackQueues,
  appendAssistantAudioChunk,
  enqueueAssistantPlaybackSegment,
  finishAssistantAudioStream,
  replayAssistantPlaybackSegments,
  getAssistantPlaybackVersion,
  isAssistantPlaybackActive,
  stopAssistantPlayback,
  startAssistantAudioStream,
} from "@/lib/playback-queue";
import type { AssistantPlaybackSegment } from "@/lib/types";

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function segment(index: number): AssistantPlaybackSegment {
  return {
    messageId: "chat-1",
    segmentIndex: index,
    rawText: `raw ${index}`,
    controls: [{ kind: "psb", type: "expression", payload: { name: `expr-${index}` } }],
    audio: { status: "ready", url: `/media/${index}.wav`, mimeType: "audio/wav" },
  };
}

describe("assistant playback queue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAssistantPlaybackQueues();
    vi.stubGlobal("Audio", class {
      currentTime = 0;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause = vi.fn();
      play = vi.fn().mockImplementation(() => {
        queueMicrotask(() => this.onended?.());
        return Promise.resolve();
      });
    });
  });

  it("waits for missing earlier segments before delegating to PSB", async () => {
    clearAssistantPlaybackQueues();
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });

    enqueueAssistantPlaybackSegment(segment(1));
    await flushMicrotasks();
    expect(sendAction).not.toHaveBeenCalled();

    enqueueAssistantPlaybackSegment(segment(0));
    await vi.waitFor(() => expect(sendAction).toHaveBeenCalledTimes(2));

    expect(sendAction).toHaveBeenCalledTimes(2);
    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual(["segment-audio", "segment-audio"]);
    expect(sendAction.mock.calls.map((call) => call[0].payload.segmentIndex)).toEqual([0, 1]);
  });

  it("drops queued segments when stopped", async () => {
    clearAssistantPlaybackQueues();
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });

    enqueueAssistantPlaybackSegment(segment(1));
    await flushMicrotasks();
    expect(sendAction).not.toHaveBeenCalled();

    stopAssistantPlayback();
    await flushMicrotasks();

    enqueueAssistantPlaybackSegment(segment(0));
    await flushMicrotasks();

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual([
      "playback-stop",
      "segment-audio",
    ]);
    expect(sendAction.mock.calls[1][0].payload.segmentIndex).toBe(0);
  });

  it("does not continue a stale local drain after playback is stopped", async () => {
    const audios: Array<{ pause: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("Audio", class {
      currentTime = 0;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause = vi.fn();
      play = vi.fn().mockResolvedValue(undefined);
      constructor() {
        audios.push(this);
      }
    });
    vi.stubGlobal("electronAPI", {
      psb: { sendAction: vi.fn().mockResolvedValue({ ok: false }) },
      systemMedia: { setTtsActive: vi.fn().mockResolvedValue(undefined) },
    });

    enqueueAssistantPlaybackSegment(segment(0));
    enqueueAssistantPlaybackSegment(segment(1));
    await flushMicrotasks(10);
    expect(audios).toHaveLength(1);

    stopAssistantPlayback();
    await flushMicrotasks(10);

    expect(audios).toHaveLength(1);
    expect(audios[0].pause).toHaveBeenCalledOnce();
  });

  it("resets a completed message before replaying its segments", async () => {
    clearAssistantPlaybackQueues();
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });

    enqueueAssistantPlaybackSegment(segment(0));
    await flushMicrotasks();
    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual(["segment-audio"]);

    await replayAssistantPlaybackSegments([segment(0), segment(1)]);
    await flushMicrotasks();

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual([
      "segment-audio",
      "playback-stop",
      "segment-audio",
      "segment-audio",
    ]);
    expect(sendAction.mock.calls.slice(2).map((call) => call[0].payload.segmentIndex)).toEqual([0, 1]);
  });

  it("exposes delegated PSB playback as active until stopped", async () => {
    clearAssistantPlaybackQueues();
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });
    const before = getAssistantPlaybackVersion();

    enqueueAssistantPlaybackSegment(segment(0));
    await flushMicrotasks();

    expect(isAssistantPlaybackActive("chat-1")).toBe(true);
    expect(getAssistantPlaybackVersion()).toBeGreaterThan(before);

    stopAssistantPlayback("chat-1");
    await flushMicrotasks();

    expect(isAssistantPlaybackActive("chat-1")).toBe(false);
  });

  it("falls back to local audio when PSB is unavailable", async () => {
    clearAssistantPlaybackQueues();
    const sendAction = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });

    enqueueAssistantPlaybackSegment(segment(0));
    await vi.waitFor(() => expect(sendAction).toHaveBeenCalledTimes(3));

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual([
      "segment-audio",
      "expression",
      "segment-end",
    ]);
  });

  it("reports one active window for contiguous TTS segments", async () => {
    const setTtsActive = vi.fn().mockResolvedValue(undefined);
    const sendAction = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("electronAPI", { psb: { sendAction }, systemMedia: { setTtsActive } });

    enqueueAssistantPlaybackSegment(segment(0));
    enqueueAssistantPlaybackSegment(segment(1));
    await vi.waitFor(() => expect(setTtsActive).toHaveBeenCalledTimes(2));

    expect(setTtsActive.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it("prebuffers two PCM chunks before delegating one logical stream", async () => {
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });
    startAssistantAudioStream({
      audioId: "speech-1",
      sampleRate: 24000,
      channels: 1,
      encoding: "pcm_s16le",
    });

    appendAssistantAudioChunk({ audioId: "speech-1", sequence: 0, data: "AAAAAA==" });
    await flushMicrotasks();
    expect(sendAction).not.toHaveBeenCalled();

    appendAssistantAudioChunk({ audioId: "speech-1", sequence: 1, data: "AAAAAA==" });
    await flushMicrotasks(10);
    await finishAssistantAudioStream({
      audioId: "speech-1",
      sampleRate: 24000,
      durationMs: 1,
    });

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual([
      "audio-stream-start",
      "audio-stream-chunk",
      "audio-stream-chunk",
      "audio-stream-end",
    ]);
  });

  it("leaves delegated PSB system-media reporting to the PSB window", async () => {
    vi.useFakeTimers();
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    const setTtsActive = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("electronAPI", { psb: { sendAction }, systemMedia: { setTtsActive } });
    startAssistantAudioStream({
      audioId: "speech-stop",
      sampleRate: 24000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    appendAssistantAudioChunk({ audioId: "speech-stop", sequence: 0, data: "AAAAAA==" });
    appendAssistantAudioChunk({ audioId: "speech-stop", sequence: 1, data: "AAAAAA==" });
    await flushMicrotasks(10);
    await finishAssistantAudioStream({ audioId: "speech-stop", sampleRate: 24000, durationMs: 1 });
    await vi.advanceTimersByTimeAsync(101);

    expect(sendAction.mock.calls.map((call) => call[0].type)).toContain("audio-stream-stop");
    expect(setTtsActive).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("plays the buffered PCM locally when the desk pet is unavailable", async () => {
    const sendAction = vi.fn().mockResolvedValue({ ok: false });
    const started: number[] = [];
    vi.stubGlobal("electronAPI", { psb: { sendAction } });
    vi.stubGlobal("AudioContext", class {
      currentTime = 0;
      state = "running";
      destination = {};
      createBuffer(_channels: number, samples: number, sampleRate: number) {
        return {
          duration: samples / sampleRate,
          getChannelData: () => new Float32Array(samples),
        };
      }
      createBufferSource() {
        return {
          buffer: null,
          connect: vi.fn(),
          start: (time: number) => started.push(time),
          stop: vi.fn(),
        };
      }
      close = vi.fn().mockResolvedValue(undefined);
      resume = vi.fn().mockResolvedValue(undefined);
    });
    startAssistantAudioStream({
      audioId: "speech-local",
      sampleRate: 24000,
      channels: 1,
      encoding: "pcm_s16le",
    });

    appendAssistantAudioChunk({ audioId: "speech-local", sequence: 0, data: "AAAAAA==" });
    appendAssistantAudioChunk({ audioId: "speech-local", sequence: 1, data: "AAAAAA==" });
    await flushMicrotasks(10);

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual(["audio-stream-start"]);
    expect(started).toHaveLength(2);
  });

  it("serializes chunks buffered while PSB ownership is pending before stream end", async () => {
    let acceptPsb: (() => void) | undefined;
    const sendAction = vi.fn().mockImplementation((action: { type: string }) => {
      if (action.type === "audio-stream-start") {
        return new Promise<{ ok: true }>((resolve) => {
          acceptPsb = () => resolve({ ok: true });
        });
      }
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });
    startAssistantAudioStream({
      audioId: "speech-pending",
      sampleRate: 24000,
      channels: 1,
      encoding: "pcm_s16le",
    });

    appendAssistantAudioChunk({ audioId: "speech-pending", sequence: 0, data: "AAAAAA==" });
    appendAssistantAudioChunk({ audioId: "speech-pending", sequence: 1, data: "AAAAAA==" });
    await flushMicrotasks();
    appendAssistantAudioChunk({ audioId: "speech-pending", sequence: 2, data: "AAAAAA==" });
    const finishing = finishAssistantAudioStream({
      audioId: "speech-pending",
      sampleRate: 24000,
      durationMs: 1,
    });

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual(["audio-stream-start"]);
    acceptPsb?.();
    await finishing;

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual([
      "audio-stream-start",
      "audio-stream-chunk",
      "audio-stream-chunk",
      "audio-stream-chunk",
      "audio-stream-end",
    ]);
    expect(sendAction.mock.calls.slice(1, 4).map((call) => call[0].payload.data)).toEqual([
      "AAAAAA==",
      "AAAAAA==",
      "AAAAAA==",
    ]);
  });

  it("does not replay a stream already owned by THA", async () => {
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("electronAPI", { psb: { sendAction } });

    startAssistantAudioStream({
      audioId: "speech-tha",
      sampleRate: 24000,
      channels: 1,
      encoding: "pcm_s16le",
      owner: "tha",
    });
    appendAssistantAudioChunk({ audioId: "speech-tha", sequence: 0, data: "AAAAAA==" });
    await finishAssistantAudioStream({ audioId: "speech-tha", sampleRate: 24000 });

    expect(sendAction).not.toHaveBeenCalled();
    expect(isAssistantPlaybackActive("speech-tha")).toBe(false);
  });

  it("leaves THA system-media reporting to the THA window", async () => {
    vi.useFakeTimers();
    const setTtsActive = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("electronAPI", {
      psb: { sendAction: vi.fn().mockResolvedValue({ ok: true }) },
      systemMedia: { setTtsActive },
    });
    startAssistantAudioStream({
      audioId: "speech-tha-duration",
      sampleRate: 24000,
      channels: 1,
      encoding: "pcm_s16le",
      owner: "tha",
    });
    await finishAssistantAudioStream({
      audioId: "speech-tha-duration",
      sampleRate: 24000,
      durationMs: 1_000,
    });

    expect(setTtsActive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_101);
    expect(setTtsActive).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
