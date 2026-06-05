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

describe("useNanobotStream inbox user events", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
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
        source_channel: "telegram",
      });
    });

    expect(result.current.isStreaming).toBe(false);
  });
});
