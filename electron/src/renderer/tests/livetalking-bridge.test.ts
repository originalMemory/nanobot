// livetalking-bridge 单测: 会话绑定、start/chunk/finish 委托与回退
import { afterEach, describe, expect, it, vi } from "vitest";

const audiostreamStart = vi.fn(async () => ({ code: 0 }));
const audiostreamChunk = vi.fn(async (_sid: string, _data: ArrayBuffer) => ({ code: 0 }));
const audiostreamFinish = vi.fn(async () => ({ code: 0 }));
const setAudiotype = vi.fn(async () => ({ code: 0 }));
const interrupt = vi.fn(async () => ({ code: 0 }));
const isSpeaking = vi.fn(async () => ({ code: 0, data: false }));

function installApi(overrides?: Record<string, unknown>) {
  const ltApi = {
    checkHealth: vi.fn(async () => ({ reachable: true, lastCheckedAtMs: 0, lastError: null })),
    offer: vi.fn(async () => ({})),
    audiostreamStart,
    audiostreamChunk,
    audiostreamFinish,
    setAudiotype,
    interrupt,
    isSpeaking,
  };
  const base = (window.electronAPI ?? {}) as Record<string, unknown>;
  const w = window as unknown as { electronAPI: Record<string, unknown> };
  w.electronAPI = {
    ...base,
    livetalking: { ...ltApi, ...(overrides ?? {}) },
  };
}

import {
  avatarCompanionInterrupt,
  avatarCompanionTurnEnd,
  avatarCompanionTurnStart,
  bindAvatarCompanionSession,
  finishLivetalkingStream,
  isAvatarCompanionAudioActive,
  sendLivetalkingChunk,
  startLivetalkingStream,
} from "../lib/livetalking-bridge";

describe("livetalking-bridge", () => {
  afterEach(() => {
    vi.clearAllMocks();
    bindAvatarCompanionSession(() => null);
  });

  it("returns false when no session bound", async () => {
    installApi();
    expect(await startLivetalkingStream("a1", 24000)).toBe(false);
    expect(audiostreamStart).not.toHaveBeenCalled();
  });

  it("delegates start/chunk/finish to the livetalking api", async () => {
    installApi();
    bindAvatarCompanionSession(() => "sid-1");
    expect(await startLivetalkingStream("a1", 24000)).toBe(true);
    expect(audiostreamStart).toHaveBeenCalledWith("sid-1", 24000);
    expect(isAvatarCompanionAudioActive()).toBe(true);

    // base64 "QUFBQQ==" -> 4 bytes
    expect(await sendLivetalkingChunk("QUFBQQ==")).toBe(true);
    expect(audiostreamChunk).toHaveBeenCalledTimes(1);
    const [sid, payload] = audiostreamChunk.mock.calls[0];
    expect(sid).toBe("sid-1");
    expect(payload instanceof ArrayBuffer).toBe(true);
    expect(payload.byteLength).toBe(4);

    await finishLivetalkingStream();
    expect(audiostreamFinish).toHaveBeenCalledWith("sid-1");
    expect(isAvatarCompanionAudioActive()).toBe(false);
  });

  it("marks inactive when a chunk fails so playback falls back locally", async () => {
    installApi({ audiostreamChunk: vi.fn(async () => { throw new Error("boom"); }) });
    bindAvatarCompanionSession(() => "sid-2");
    await startLivetalkingStream("a1", 16000);
    expect(await sendLivetalkingChunk("QUFBQQ==")).toBe(false);
    expect(isAvatarCompanionAudioActive()).toBe(false);
  });

  it("connects lazily for speech and keeps idle/work local", async () => {
    installApi();
    let sid: string | null = null;
    const connect = vi.fn(async () => {
      sid = "sid-3";
      return true;
    });
    const disconnect = vi.fn();
    bindAvatarCompanionSession(() => sid, connect, disconnect);

    avatarCompanionTurnStart();
    avatarCompanionTurnEnd();
    expect(setAudiotype).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();

    expect(await startLivetalkingStream("a1", 16000)).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(audiostreamStart).toHaveBeenCalledWith("sid-3", 16000);
    avatarCompanionInterrupt();
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith("sid-3"));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
