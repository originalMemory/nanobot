import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import {
  assistantTurnFooterFlags,
  assistantTurnHeaderMessages,
  buildDisplayUnits,
  ThreadMessages,
} from "@/components/thread/ThreadMessages";
import { isNearThreadBottom, ThreadViewport } from "@/components/thread/ThreadViewport";
import type { NanobotClient } from "@/lib/nanobot-client";
import type { UIMessage } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

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

function turnMessage(
  message: Omit<UIMessage, "turnId" | "turnSeq">,
  turnId = "turn-1",
  turnSeq = 0,
): UIMessage {
  return { ...message, turnId, turnSeq };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ThreadMessages turn timeline", () => {
  it("only treats the viewport as sticky near the bottom", () => {
    expect(isNearThreadBottom(12)).toBe(true);
    expect(isNearThreadBottom(120)).toBe(false);
  });

  it("uses one translucent surface around the full thread viewport", () => {
    const { container } = render(
      <ClientProvider
        client={{} as NanobotClient}
        token=""
        apiBase="http://127.0.0.1:8765"
      >
        <ThreadViewport
          messages={[turnMessage({
            id: "a1",
            role: "assistant",
            content: "answer",
            createdAt: 1,
          })]}
          isStreaming={false}
          composer={<div>composer</div>}
        />
      </ClientProvider>,
    );

    const surface = screen.getByTestId("thread-viewport-surface");
    expect(surface).toHaveClass("bg-background/60");
    expect(surface.className).not.toContain("backdrop-blur");
    expect(screen.getByTestId("thread-message-region")).toHaveClass("pb-4");
    expect(screen.getByTestId("thread-message-region")).not.toHaveClass("pb-20");
    expect(screen.getByTestId("thread-composer-dock")).toHaveClass("bg-transparent");
    expect(container.querySelector(".chat-ai-bubble")).toBeNull();
  });

  it("always shows the reply model and marks fallback separately", () => {
    const { rerender } = renderThread([
      turnMessage({
        id: "a1",
        role: "assistant",
        content: "primary reply",
        responseModel: "openai/gpt-4.1",
        fallbackUsed: false,
        createdAt: 1,
      }),
    ]);

    expect(screen.getByTestId("response-model-summary")).toHaveTextContent(
      /openai\/gpt-4\.1/,
    );
    expect(screen.getByTestId("response-model-summary")).toHaveClass(
      "text-muted-foreground/50",
    );
    expect(screen.getByTestId("response-model-summary").closest(
      ".assistant-message-footer",
    )).not.toBeNull();
    expect(screen.queryByText(/已降级|Fallback used/)).not.toBeInTheDocument();

    rerender(
      <ClientProvider
        client={{} as NanobotClient}
        token=""
        apiBase="http://127.0.0.1:8765"
      >
        <ThreadMessages
          messages={[
            turnMessage({
              id: "a2",
              role: "assistant",
              content: "fallback reply",
              responseModel: "openai/gpt-4.1-mini",
              fallbackUsed: true,
              createdAt: 2,
            }),
          ]}
        />
      </ClientProvider>,
    );
    expect(screen.getByTestId("response-model-summary")).toHaveTextContent(
      /openai\/gpt-4\.1-mini/,
    );
    expect(screen.getByText(/已降级|Fallback used/)).toBeInTheDocument();
  });

  it("keeps interleaved activity and assistant replies as separate units", () => {
    const messages: UIMessage[] = [
      turnMessage({
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "plan read",
        createdAt: 1,
      }, "turn-1", 1),
      turnMessage({
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        createdAt: 2,
      }, "turn-1", 2),
      turnMessage({
        id: "a1",
        role: "assistant",
        content: "先看下文件。",
        createdAt: 3,
      }, "turn-1", 3),
      turnMessage({
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
      }, "turn-1", 4),
      turnMessage({
        id: "a2",
        role: "assistant",
        content: "改好了。",
        latencyMs: 34_000,
        createdAt: 5,
      }, "turn-1", 5),
    ];

    const units = buildDisplayUnits(messages);
    expect(units.map((unit) => unit.type)).toEqual([
      "activity",
      "message",
      "activity",
      "message",
    ]);
    expect(units.filter((unit) => unit.type === "message")).toHaveLength(2);
  });

  it("orders one turn by turnSeq instead of arrival order", () => {
    const messages: UIMessage[] = [
      turnMessage({ id: "a2", role: "assistant", content: "second", createdAt: 2 }, "turn-1", 2),
      turnMessage({ id: "a1", role: "assistant", content: "first", createdAt: 1 }, "turn-1", 1),
    ];
    const units = buildDisplayUnits(messages);
    expect(units.map((unit) => unit.type === "message" ? unit.message.id : "")).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("does not merge proactive delivery with the previous turn", () => {
    const messages: UIMessage[] = [
      turnMessage({ id: "u1", role: "user", content: "phase2?", createdAt: 1 }, "turn-user", 0),
      turnMessage({ id: "a1", role: "assistant", content: "explanation", createdAt: 2 }, "turn-user", 1),
      turnMessage({
        id: "a2",
        role: "assistant",
        content: "早上好",
        channelDelivery: true,
        createdAt: 3,
      }, "turn-cron", 0),
    ];
    const units = buildDisplayUnits(messages);
    expect(units.map((unit) => unit.type === "message" ? unit.message.turnId : "")).toEqual([
      "turn-user",
      "turn-user",
      "turn-cron",
    ]);
  });

  it("shows one turn header and footer only on the last reply", () => {
    const units = buildDisplayUnits([
      turnMessage({ id: "a1", role: "assistant", content: "part one", createdAt: 1 }, "turn-1", 1),
      turnMessage({
        id: "a2",
        role: "assistant",
        content: "part two",
        latencyMs: 2_000,
        createdAt: 2,
      }, "turn-1", 2),
    ]);
    expect(assistantTurnFooterFlags(units)).toEqual([false, true]);
    expect(assistantTurnHeaderMessages(units).map((message) => message?.id ?? null)).toEqual([
      "a1",
      null,
    ]);

    const { container } = renderThread(
      units.flatMap((unit) => unit.type === "message" ? [unit.message] : unit.messages),
    );
    expect(screen.getAllByTestId("assistant-turn-identity")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /copy reply|复制回复/i })).toHaveLength(1);
    expect(container.querySelectorAll(".assistant-message-footer")).toHaveLength(1);
    expect(container.querySelector(".assistant-message-footer-metric")).toHaveTextContent("2s");
  });

  it("renders the turn header before activity and document-style assistant text", () => {
    const { container } = renderThread([
      turnMessage({
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        createdAt: 1,
      }, "turn-1", 1),
      turnMessage({
        id: "a1",
        role: "assistant",
        content: "文件看完了。",
        sourceChannel: "telegram",
        latencyMs: 148_000,
        createdAt: 2,
      }, "turn-1", 2),
    ]);

    const identity = screen.getByTestId("assistant-turn-identity");
    const activity = screen.getByRole("button", {
      name: /worked|working|thought|thinking|处理|思考/i,
    });
    const answer = screen.getByText("文件看完了。");

    expect(identity.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/telegram/i)).toBeInTheDocument();
    expect(activity).toHaveAttribute("aria-expanded", "false");
    expect(activity).not.toHaveAccessibleName(/2m|148|分钟/);
    expect(answer.closest("[data-message-id]")).toHaveAttribute("class", "");
    expect(container.querySelector(".chat-ai-bubble")).toBeNull();
  });

  it("keeps replayed reasoning in turnSeq order with tool traces", () => {
    const units = buildDisplayUnits([
      turnMessage({
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "grep()",
        traces: ["grep()"],
        createdAt: 2,
      }, "turn-1", 1),
      turnMessage({
        id: "a1",
        role: "assistant",
        content: "final answer",
        reasoning: "earliest thought",
        createdAt: 4,
      }, "turn-1", 2),
    ]);
    expect(units[0].type).toBe("activity");
    if (units[0].type !== "activity") return;
    expect(units[0].messages.map((message) => message.id)).toEqual([
      "t1",
      "a1-reasoning",
    ]);
  });

  it("renders assistant media-only messages", () => {
    renderThread([
      turnMessage({
        id: "a1",
        role: "assistant",
        content: "",
        media: [{
          kind: "image",
          url: "data:image/png;base64,iVBORw0KGgo=",
          name: "generated.png",
        }],
        createdAt: 1,
      }),
    ]);
    expect(screen.getByAltText("generated.png")).toBeInTheDocument();
  });

  it("preserves playback segments on each original assistant message", () => {
    const messages = [
      turnMessage({
        id: "a1",
        role: "assistant",
        content: "part one",
        playbackSegments: [{
          messageId: "a1",
          segmentIndex: 0,
          rawText: "part one",
          audio: { status: "ready", url: "/audio/one.mp3" },
        }],
        createdAt: 1,
      }, "turn-1", 1),
      turnMessage({
        id: "a2",
        role: "assistant",
        content: "part two",
        playbackSegments: [{
          messageId: "a2",
          segmentIndex: 0,
          rawText: "part two",
          audio: { status: "ready", url: "/audio/two.mp3" },
        }],
        createdAt: 2,
      }, "turn-1", 2),
    ];
    const units = buildDisplayUnits(messages);
    const assistantMessages = units.flatMap(
      (unit) => unit.type === "message" && unit.message.role === "assistant"
        ? [unit.message]
        : [],
    );
    expect(assistantMessages.map((message) => message.playbackSegments?.[0]?.messageId)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("keeps trailing tool activity expanded while its turn is running", () => {
    renderThread([
      turnMessage({ id: "u1", role: "user", content: "edit", createdAt: 1 }, "turn-1", 0),
      turnMessage({
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "edit_file()",
        traces: ["edit_file()"],
        createdAt: 2,
      }, "turn-1", 1),
    ], true);
    expect(screen.getByRole("button", {
      name: /worked|working|thought|thinking|处理|思考/i,
    })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("agent-activity-scroll")).toBeInTheDocument();
  });

  it("briefly keeps completed reasoning expanded before auto-collapsing", () => {
    vi.useFakeTimers();
    const messages = [
      turnMessage({ id: "u1", role: "user", content: "hi", createdAt: 1 }, "turn-1", 0),
      turnMessage({
        id: "a1",
        role: "assistant",
        content: "answer",
        reasoning: "thinking text",
        isStreaming: true,
        createdAt: 2,
      }, "turn-1", 1),
    ];
    const { rerender } = renderThread(messages, true);
    const reasoningText = screen.getByText("thinking text");
    expect(reasoningText).toBeInTheDocument();
    const reasoningLine = reasoningText.closest("[data-testid='activity-line']");
    expect(reasoningLine).toHaveClass("whitespace-normal");
    expect(reasoningLine).not.toHaveAttribute("title");
    expect(reasoningText).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(reasoningText).not.toHaveClass("truncate");
    const activityToggle = screen.getByRole("button", {
      name: /worked|working|thought|thinking|处理|思考/i,
    });
    expect(activityToggle).toHaveAttribute("aria-expanded", "true");

    rerender(
      <ClientProvider
        client={{} as NanobotClient}
        token=""
        apiBase="http://127.0.0.1:8765"
      >
        <ThreadMessages
          messages={[messages[0], { ...messages[1], isStreaming: false }]}
          isStreaming={false}
        />
      </ClientProvider>,
    );
    expect(activityToggle).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(899));
    expect(activityToggle).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(activityToggle).toHaveAttribute("aria-expanded", "false");
  });
});
