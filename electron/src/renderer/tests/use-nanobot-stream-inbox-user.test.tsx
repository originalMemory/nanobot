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
  let turnSeq = 0;
  const client = {
    onChat: (chatId: string, handler: (ev: InboundEvent) => void) => {
      chatHandlers.set(chatId, (event) => handler({
        ...event,
        turn_id: event.turn_id ?? "turn-test",
        turn_phase: event.turn_phase ?? (
          event.event === "user"
            ? "user"
            : event.event === "turn_end"
              ? "complete"
              : event.event.startsWith("reasoning")
                ? "reasoning"
                : event.event === "message" && event.kind
                  ? "activity"
                  : "answer"
        ),
        turn_seq: event.turn_seq ?? turnSeq++,
      }));
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

  it("renders every received delta character across callback rerenders", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));

    const { client, chatHandlers } = createMockClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} token="t" apiBase="http://127.0.0.1:8765">
        {children}
      </ClientProvider>
    );
    const text = "abcdefghijklmnopqrstuvwxyz0123456789";
    const { result, rerender } = renderHook(
      ({ onTurnEnd }: { onTurnEnd: () => void }) => (
        useNanobotStream("inbox:unified", [], false, onTurnEnd)
      ),
      { wrapper, initialProps: { onTurnEnd: vi.fn() } },
    );

    act(() => {
      chatHandlers.get("inbox:unified")!({
        event: "delta",
        chat_id: "inbox:unified",
        stream_id: "stream-a",
        text,
      });
    });
    rerender({ onTurnEnd: vi.fn() });
    act(() => {
      for (const callback of [...frames.values()]) callback(0);
    });

    expect(result.current.messages[0]?.content).toBe(text);
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

  it("shows the actual fallback model only for the active turn", () => {
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
        event: "turn_model_updated",
        chat_id: "inbox:unified",
        model_name: "openai/gpt-4.1-mini",
        provider: "openai",
        is_fallback: true,
      });
    });
    expect(result.current.turnModelName).toBe("openai/gpt-4.1-mini");
    expect(result.current.turnModelProvider).toBe("openai");

    act(() => {
      handle({
        event: "turn_model_updated",
        chat_id: "inbox:unified",
        model_name: "openai/gpt-4.1",
        is_fallback: false,
      });
    });
    expect(result.current.turnModelName).toBeNull();
    expect(result.current.turnModelProvider).toBeNull();

    act(() => {
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
      });
    });
    expect(result.current.turnModelName).toBeNull();
  });

  it("keeps the reply model and fallback marker on the completed message", () => {
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

    act(() => {
      chatHandlers.get("inbox:unified")!({
        event: "message",
        chat_id: "inbox:unified",
        text: "fallback reply",
        response_model: "openai/gpt-4.1-mini",
        response_provider: "openai",
        fallback_used: true,
        fallback_models: [
          { model: "openai/gpt-4.1-mini", provider: "openai" },
        ],
        usage: {
          last_prompt_tokens: 1200,
          turn_completion_tokens: 80,
        },
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      responseModel: "openai/gpt-4.1-mini",
      responseProvider: "openai",
      fallbackUsed: true,
      fallbackModels: [
        { model: "openai/gpt-4.1-mini", provider: "openai" },
      ],
      usage: {
        last_prompt_tokens: 1200,
        turn_completion_tokens: 80,
      },
    });

    act(() => {
      chatHandlers.get("inbox:unified")!({
        event: "delta",
        chat_id: "inbox:unified",
        text: "streamed",
        turn_id: "turn-streamed",
      });
      chatHandlers.get("inbox:unified")!({
        event: "turn_end",
        chat_id: "inbox:unified",
        turn_id: "turn-streamed",
        response_model: "anthropic/claude-sonnet",
        fallback_used: false,
      });
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "streamed",
      responseModel: "anthropic/claude-sonnet",
      fallbackUsed: false,
    });
  });

  it("保留后端已交给 THA 播放的消息标记", () => {
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

    act(() => {
      chatHandlers.get("inbox:unified")!({
        event: "message",
        chat_id: "inbox:unified",
        text: "voice",
        media_urls: [{ url: "/media/reply.mp3", name: "reply.mp3" }],
        tha_played: true,
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      thaPlayed: true,
    });
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

  it("finalizes only the matching turn when turn events interleave", () => {
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
        text: "A",
        turn_id: "turn-a",
        turn_phase: "answer",
        turn_seq: 1,
      });
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        stream_id: "stream-b",
        text: "B",
        turn_id: "turn-b",
        turn_phase: "answer",
        turn_seq: 1,
      });
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
        turn_id: "turn-a",
        turn_phase: "complete",
        turn_seq: 2,
      });
    });

    expect(result.current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "turn-a", content: "A", isStreaming: false }),
      expect.objectContaining({ turnId: "turn-b", content: "B", isStreaming: true }),
    ]));
    expect(result.current.isStreaming).toBe(true);
  });

  it("keeps streamed reasoning when answer delta adopts a stream id", () => {
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
        event: "reasoning_delta",
        chat_id: "inbox:unified",
        text: "thinking",
      });
      handle({
        event: "reasoning_end",
        chat_id: "inbox:unified",
      });
      handle({
        event: "delta",
        chat_id: "inbox:unified",
        stream_id: "stream-a",
        text: "answer",
      });
      handle({
        event: "turn_end",
        chat_id: "inbox:unified",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: "stream-a",
      role: "assistant",
      content: "answer",
      reasoning: "thinking",
      reasoningStreaming: false,
      isStreaming: false,
    });
  });

  it("keeps a live reasoning placeholder when sending a follow-up mid-turn", () => {
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
        event: "reasoning_delta",
        chat_id: "inbox:unified",
        text: "thinking",
      });
    });

    act(() => {
      result.current.send("also consider edge cases");
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "",
      reasoning: "thinking",
      reasoningStreaming: true,
    });
    expect(result.current.messages[1]).toMatchObject({
      role: "user",
      content: "also consider edge cases",
    });
  });
});
