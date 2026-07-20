import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import {
  assistantCopyFlags,
  buildDisplayUnits,
  buildFinalDisplayUnits,
  ThreadMessages,
} from "@/components/thread/ThreadMessages";
import type { NanobotClient } from "@/lib/nanobot-client";
import { ClientProvider } from "@/providers/ClientProvider";
import type { UIMessage } from "@/lib/types";

function renderThread(messages: UIMessage[], isStreaming = false) {
  return render(
    <ClientProvider
      client={{} as NanobotClient}
      token=""
      apiBase="http://127.0.0.1:8765"
    >
      <ThreadMessages messages={messages} isStreaming={isStreaming} />
    </ClientProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ThreadMessages turn coalescing", () => {
  it("merges interleaved activity and text into one assistant-turn unit", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "plan read",
        reasoningStreaming: false,
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        createdAt: 2,
      },
      {
        id: "a1",
        role: "assistant",
        content: "先看下文件。",
        createdAt: 3,
      },
      {
        id: "t2",
        role: "tool",
        kind: "trace",
        content: "edit_file()",
        traces: ["edit_file()"],
        fileEdits: [{
          call_id: "call-edit",
          tool: "edit_file",
          path: "HEARTBEAT.md",
          phase: "end",
          added: 1,
          deleted: 0,
          status: "done",
        }],
        createdAt: 4,
      },
      {
        id: "a2",
        role: "assistant",
        content: "改好了。",
        latencyMs: 34_000,
        createdAt: 5,
      },
    ];

    const raw = buildDisplayUnits(messages);
    expect(raw.map((u) => u.type)).toEqual(["cluster", "single", "cluster", "single"]);

    const units = buildFinalDisplayUnits(messages, false);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe("assistant-turn");
    if (units[0].type !== "assistant-turn") return;
    expect(units[0].segments.map((s) => s.kind)).toEqual([
      "activity",
      "text",
      "activity",
      "text",
    ]);
  });

  it("keeps user messages as separate units", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "hello", createdAt: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "hi",
        createdAt: 2,
      },
    ];
    const units = buildFinalDisplayUnits(messages, false);
    expect(units).toHaveLength(2);
    expect(units[0].type).toBe("single");
    expect(units[1].type).toBe("assistant-turn");
  });

  it("marks only the last assistant-turn as streaming", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "one", createdAt: 1 },
      { id: "a1", role: "assistant", content: "done", createdAt: 2 },
      { id: "u2", role: "user", content: "two", createdAt: 3 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "thinking",
        reasoningStreaming: true,
        createdAt: 4,
      },
    ];
    const units = buildFinalDisplayUnits(messages, true);
    expect(units.filter((u) => u.type === "assistant-turn").map((u) => (
      u.type === "assistant-turn" ? u.isStreaming : false
    ))).toEqual([false, true]);
  });

  it("does not revive a completed assistant turn after a follow-up user message", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "one", createdAt: 1 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "done thinking",
        reasoningStreaming: false,
        createdAt: 2,
      },
      { id: "a1", role: "assistant", content: "done", createdAt: 3 },
      { id: "u2", role: "user", content: "follow up", createdAt: 4 },
    ];

    const units = buildFinalDisplayUnits(messages, true);
    const assistantTurns = units.filter((u) => u.type === "assistant-turn");
    expect(assistantTurns).toHaveLength(1);
    if (assistantTurns[0]?.type !== "assistant-turn") throw new Error("expected assistant turn");
    expect(assistantTurns[0].isStreaming).toBe(false);
  });

  it("keeps an active assistant turn streaming after a follow-up user message", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "one", createdAt: 1 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "still thinking",
        reasoningStreaming: true,
        isStreaming: true,
        createdAt: 2,
      },
      { id: "u2", role: "user", content: "follow up", createdAt: 3 },
    ];

    const units = buildFinalDisplayUnits(messages, true);
    const assistantTurns = units.filter((u) => u.type === "assistant-turn");
    expect(assistantTurns).toHaveLength(1);
    if (assistantTurns[0]?.type !== "assistant-turn") throw new Error("expected assistant turn");
    expect(assistantTurns[0].isStreaming).toBe(true);
  });

  it("inserts replayed early reasoning before tool traces when cluster has no leading reasoning", () => {
    const messages: UIMessage[] = [
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "grep()",
        traces: ["grep()"],
        createdAt: 2,
      },
      {
        id: "t2",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        createdAt: 3,
      },
      {
        id: "a1",
        role: "assistant",
        content: "final answer",
        reasoning: "earliest thought",
        reasoningStreaming: false,
        createdAt: 4,
      },
    ];

    const raw = buildDisplayUnits(messages);
    expect(raw).toHaveLength(2);
    expect(raw[0].type).toBe("cluster");
    if (raw[0].type !== "cluster") return;
    expect(raw[0].messages.map((m) => m.id)).toEqual([
      "a1-reasoning",
      "t1",
      "t2",
    ]);
  });

  it("appends post-tool reasoning after traces when cluster already has leading reasoning", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "search plan",
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "grep()",
        traces: ["grep()"],
        createdAt: 2,
      },
      {
        id: "a1",
        role: "assistant",
        content: "final answer",
        reasoning: "summarize results",
        createdAt: 3,
      },
    ];

    const raw = buildDisplayUnits(messages);
    if (raw[0].type !== "cluster") throw new Error("expected cluster");
    expect(raw[0].messages.map((m) => m.id)).toEqual([
      "r1",
      "t1",
      "a1-reasoning",
    ]);
  });

  it("shows multiple thought headers that become duration labels after completion", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "first thought",
        reasoningStreaming: false,
        createdAt: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: "第一段正文。",
        createdAt: 4_000,
      },
      {
        id: "r2",
        role: "assistant",
        content: "",
        reasoning: "second thought",
        reasoningStreaming: false,
        createdAt: 5_000,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        createdAt: 8_000,
      },
      {
        id: "a2",
        role: "assistant",
        content: "最终总结。",
        latencyMs: 12_000,
        createdAt: 12_000,
      },
    ];

    renderThread(messages, false);

    expect(screen.getAllByText(/Thought for|思考了/i)).toHaveLength(2);
    expect(screen.getByText("第一段正文。")).toBeInTheDocument();
    expect(screen.getByText("最终总结。")).toBeInTheDocument();
  });

  it("renders assistant media-only messages inside a coalesced turn", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        media: [{
          kind: "image",
          url: "data:image/png;base64,iVBORw0KGgo=",
          name: "generated.png",
        }],
        createdAt: 1,
      },
    ];

    renderThread(messages, false);

    expect(screen.getByAltText("generated.png")).toBeInTheDocument();
  });

  it("splits proactive channel delivery from the previous assistant turn", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "phase2?", createdAt: 1 },
      { id: "a1", role: "assistant", content: "explanation", createdAt: 2 },
      {
        id: "a2",
        role: "assistant",
        content: "早上好",
        channelDelivery: true,
        createdAt: 3,
      },
    ];
    const units = buildFinalDisplayUnits(messages, false);
    expect(units).toHaveLength(3);
    expect(units.filter((u) => u.type === "assistant-turn")).toHaveLength(2);
    if (units[1].type !== "assistant-turn" || units[2].type !== "assistant-turn") return;
    expect(units[1].segments).toHaveLength(1);
    expect(units[2].segments).toHaveLength(1);
    if (units[2].segments[0].kind !== "text") return;
    expect(units[2].segments[0].message.channelDelivery).toBe(true);
  });

  it("only enables copy on the final coalesced assistant turn unit", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "hi", createdAt: 1 },
      { id: "a1", role: "assistant", content: "part one", createdAt: 2 },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read()",
        traces: ["read()"],
        createdAt: 3,
      },
      { id: "a2", role: "assistant", content: "part two", createdAt: 4 },
      { id: "u2", role: "user", content: "again", createdAt: 5 },
      { id: "a3", role: "assistant", content: "latest", createdAt: 6 },
    ];
    const units = buildFinalDisplayUnits(messages, false);
    expect(assistantCopyFlags(units)).toEqual([true, true, true, true]);
    expect(units.filter((u) => u.type === "assistant-turn")).toHaveLength(2);
  });

  it("keeps activity reasoning open until after the full assistant turn ends", () => {
    vi.useFakeTimers();
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "hi", createdAt: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "answer",
        reasoning: "thinking text",
        reasoningStreaming: false,
        isStreaming: true,
        createdAt: 2,
      },
    ];

    const { rerender } = renderThread(messages, true);
    expect(screen.getByText("thinking text")).toBeInTheDocument();

    rerender(
      <ClientProvider
        client={{} as NanobotClient}
        token=""
        apiBase="http://127.0.0.1:8765"
      >
        <ThreadMessages
          messages={[{ ...messages[0] }, { ...messages[1], isStreaming: false }]}
          isStreaming={false}
        />
      </ClientProvider>,
    );
    expect(screen.getByText("thinking text")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(screen.getByText("thinking text")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("thinking text")).not.toBeInTheDocument();
  });
});
