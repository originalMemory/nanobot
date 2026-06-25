import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNanobotStream } from "@/hooks/useNanobotStream";
import type { NanobotClient } from "@/lib/nanobot-client";
import type { InboundEvent } from "@/lib/types";
import { VISION_CAPTION_SENTINEL } from "@/lib/vision-caption";
import { ClientProvider } from "@/providers/ClientProvider";

function createMockClient() {
  const chatHandlers = new Map<string, (ev: InboundEvent) => void>();
  const client = {
    onChat: (chatId: string, handler: (ev: InboundEvent) => void) => {
      chatHandlers.set(chatId, handler);
      return () => {
        chatHandlers.delete(chatId);
      };
    },
    onError: () => () => {},
    getRunStartedAt: (): null => null,
    getGoalState: (): undefined => undefined,
    sendMessage: vi.fn(),
  } as unknown as NanobotClient;
  return { client, chatHandlers };
}

function setupElectronTrayMock() {
  window.electronAPI = {
    ...window.electronAPI,
    tray: { notifyIncoming: vi.fn().mockResolvedValue(undefined) },
  } as Window["electronAPI"];
}

describe("useNanobotStream inbox user events", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    setupElectronTrayMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends external channel user messages with sourceChannel", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    const { result } = renderHook(
      () => useNanobotStream("inbox:unified", []),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified");
    expect(handle).toBeDefined();

    act(() => {
      handle!({
        event: "user",
        chat_id: "inbox:unified",
        text: "hi from telegram",
        source_channel: "telegram",
        source_chat_id: "tg-123",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "hi from telegram",
      sourceChannel: "telegram",
    });
    expect(result.current.isStreaming).toBe(false);
    expect(window.electronAPI.tray.notifyIncoming).toHaveBeenCalledOnce();
  });

  it("频道过滤时不为其他 channel 的 user 入站触发托盘", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    renderHook(
      () => useNanobotStream("inbox:unified", [], false, undefined, "telegram"),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified")!;

    act(() => {
      handle({
        event: "user",
        chat_id: "inbox:unified",
        text: "hi from discord",
        source_channel: "discord",
      });
    });

    expect(window.electronAPI.tray.notifyIncoming).not.toHaveBeenCalled();
  });

  it("streams vision caption onto external user message with media", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    const { result } = renderHook(
      () => useNanobotStream("inbox:unified", []),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified")!;

    act(() => {
      handle({
        event: "user",
        chat_id: "inbox:unified",
        text: "",
        source_channel: "telegram",
        source_chat_id: "tg-123",
        media_urls: [{ url: "/api/media/sig/photo.png", name: "photo.png" }],
      });
    });

    act(() => {
      handle({
        event: "vision_caption_delta",
        chat_id: "inbox:unified",
        text: "一只",
        image_index: 0,
        source_channel: "telegram",
      });
    });

    expect(result.current.messages[0].visionCaptionStreaming).toBe(true);

    act(() => {
      handle({
        event: "vision_caption_end",
        chat_id: "inbox:unified",
        text: "一只橘猫",
        image_index: 0,
        source_channel: "telegram",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    const user = result.current.messages[0];
    expect(user.role).toBe("user");
    expect(user.media).toHaveLength(1);
    expect(user.content).toContain(VISION_CAPTION_SENTINEL);
    expect(user.content).toContain("图片描述：一只");
    expect(user.visionCaptionStreaming).toBe(false);
  });

  it("turn_end clears isStreaming after external caption delta", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    const { result } = renderHook(
      () => useNanobotStream("inbox:unified", []),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified")!;

    act(() => {
      handle({
        event: "user",
        chat_id: "inbox:unified",
        text: "",
        source_channel: "telegram",
        media_urls: [{ url: "/api/media/sig/photo.png", name: "photo.png" }],
      });
      handle({
        event: "vision_caption_delta",
        chat_id: "inbox:unified",
        text: "识别中",
        image_index: 0,
      });
    });

    expect(result.current.isStreaming).toBe(true);

    act(() => {
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
      });
    });

    expect(result.current.isStreaming).toBe(false);
  });

  it("turn_end 在流式 assistant delta 后触发托盘通知", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    renderHook(
      () => useNanobotStream("inbox:unified", []),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified")!;

    act(() => {
      handle({
        event: "user",
        chat_id: "inbox:unified",
        text: "question",
        source_channel: "telegram",
      });
    });

    expect(window.electronAPI.tray.notifyIncoming).toHaveBeenCalledOnce();
    vi.mocked(window.electronAPI.tray.notifyIncoming).mockClear();

    act(() => {
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        text: "answer chunk",
      });
    });

    expect(window.electronAPI.tray.notifyIncoming).not.toHaveBeenCalled();

    act(() => {
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
      });
    });

    expect(window.electronAPI.tray.notifyIncoming).toHaveBeenCalledOnce();
  });

  it("频道过滤时流式 turn_end 不匹配 source_channel 不触发", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    renderHook(
      () => useNanobotStream("inbox:unified", [], false, undefined, "telegram"),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified")!;

    act(() => {
      handle({
        event: "user",
        chat_id: "inbox:unified",
        text: "question",
        source_channel: "discord",
      });
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        text: "answer chunk",
      });
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
      });
    });

    expect(window.electronAPI.tray.notifyIncoming).not.toHaveBeenCalled();
  });

  it("流式 turn_end 后清理 source_channel，避免下一轮无来源 delta 误触发", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    renderHook(
      () => useNanobotStream("inbox:unified", [], false, undefined, "telegram"),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified")!;

    act(() => {
      handle({
        event: "user",
        chat_id: "inbox:unified",
        text: "question",
        source_channel: "telegram",
      });
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        text: "answer chunk",
      });
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
      });
    });

    expect(window.electronAPI.tray.notifyIncoming).toHaveBeenCalledTimes(2);
    vi.mocked(window.electronAPI.tray.notifyIncoming).mockClear();

    act(() => {
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        text: "local answer chunk",
      });
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
      });
    });

    expect(window.electronAPI.tray.notifyIncoming).not.toHaveBeenCalled();
  });

  it("keeps interleaved assistant stream ids in separate messages", () => {
    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );

    const { result } = renderHook(
      () => useNanobotStream("inbox:unified", []),
      { wrapper },
    );

    const handle = chatHandlers.get("inbox:unified")!;

    act(() => {
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        stream_id: "stream-a",
        text: "A1",
      });
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        stream_id: "stream-b",
        text: "B1",
      });
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        stream_id: "stream-a",
        text: "A2",
      });
    });

    expect(result.current.messages.map((message) => ({
      id: message.id,
      content: message.content,
    }))).toEqual([
      { id: "stream-a", content: "A1A2" },
      { id: "stream-b", content: "B1" },
    ]);
  });
});
