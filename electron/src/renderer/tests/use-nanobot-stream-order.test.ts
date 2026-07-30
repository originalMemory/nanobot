import { describe, expect, it } from "vitest";

import { findStreamingAssistantIndex } from "@/hooks/useNanobotStream";
import type { UIMessage } from "@/lib/types";

describe("useNanobotStream ordering helpers", () => {
  const turn = { turnId: "turn-1", turnPhase: "answer" as const, turnSeq: 2 };

  it("does not attach post-tool answer deltas to a pre-tool reasoning placeholder", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "question", turnId: "turn-1", createdAt: 1 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "thinking",
        reasoningStreaming: false,
        isStreaming: true,
        turnId: "turn-1",
        createdAt: 2,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        turnId: "turn-1",
        createdAt: 3,
      },
    ];

    expect(findStreamingAssistantIndex(messages, new Set(), turn)).toBeNull();
  });

  it("can still attach deltas to the latest streaming assistant before any tool trace", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "question", turnId: "turn-1", createdAt: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "partial",
        isStreaming: true,
        turnId: "turn-1",
        createdAt: 2,
      },
    ];

    expect(findStreamingAssistantIndex(messages, new Set(), turn)).toBe(1);
  });
});
