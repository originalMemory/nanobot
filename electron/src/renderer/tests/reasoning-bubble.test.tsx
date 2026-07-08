import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { ReasoningBubble } from "@/components/MessageBubble";

describe("ReasoningBubble", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a few seconds after the assistant turn ends", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ReasoningBubble text="thinking text" streaming turnStreaming hasBodyBelow />,
    );

    expect(screen.getByText("thinking text")).toBeInTheDocument();

    rerender(
      <ReasoningBubble text="thinking text" streaming={false} turnStreaming hasBodyBelow />,
    );
    expect(screen.getByText("thinking text")).toBeInTheDocument();

    rerender(
      <ReasoningBubble text="thinking text" streaming={false} turnStreaming={false} hasBodyBelow />,
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
