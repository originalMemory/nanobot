import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useNanobotStream } from "@/hooks/useNanobotStream";
import type { NanobotClient } from "@/lib/nanobot-client";
import type { InboundEvent } from "@/lib/types";
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
});
