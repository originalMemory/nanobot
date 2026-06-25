import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAssistantPlaybackQueues,
  enqueueAssistantPlaybackSegment,
  replayAssistantPlaybackSegments,
  getAssistantPlaybackVersion,
  isAssistantPlaybackActive,
  stopAssistantPlayback,
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
    clearAssistantPlaybackQueues();
    vi.restoreAllMocks();
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
    await flushMicrotasks();

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
    await flushMicrotasks();

    expect(sendAction.mock.calls.map((call) => call[0].type)).toEqual([
      "segment-audio",
      "expression",
      "segment-end",
    ]);
  });
});
