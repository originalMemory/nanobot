import { describe, expect, it } from "vitest";

import { drainPendingStreamEvents, findStreamingAssistantIndex } from "@/hooks/useNanobotStream";
import type { UIMessage } from "@/lib/types";

describe("useNanobotStream ordering helpers", () => {
  it("does not attach post-tool answer deltas to a pre-tool reasoning placeholder", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "question", createdAt: 1 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "thinking",
        reasoningStreaming: false,
        isStreaming: true,
        createdAt: 2,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        createdAt: 3,
      },
    ];

    expect(findStreamingAssistantIndex(messages, new Set())).toBeNull();
  });

  it("can still attach deltas to the latest streaming assistant before any tool trace", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "question", createdAt: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "partial",
        isStreaming: true,
        createdAt: 2,
      },
    ];

    expect(findStreamingAssistantIndex(messages, new Set())).toBe(1);
  });

  it("paces pending stream events without dropping the remainder", () => {
    const events = [
      { kind: "delta" as const, text: "abcdefghijklmnopqrstuvwxyz", streamId: "s1" },
      { kind: "delta" as const, text: "12345", streamId: "s1" },
    ];

    expect(drainPendingStreamEvents(events, 10)).toEqual([
      { kind: "delta", text: "abcdefghij", streamId: "s1" },
    ]);
    expect(events).toEqual([
      { kind: "delta", text: "klmnopqrstuvwxyz", streamId: "s1" },
      { kind: "delta", text: "12345", streamId: "s1" },
    ]);
  });
});
