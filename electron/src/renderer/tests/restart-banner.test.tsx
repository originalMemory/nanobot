import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { RestartBanner } from "@/components/settings/RestartBanner";

describe("RestartBanner", () => {
  it("renders nothing when visible=false", () => {
    render(<RestartBanner visible={false} onRestart={() => {}} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the banner when visible=true", () => {
    render(<RestartBanner visible onRestart={() => {}} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
    // Banner copy comes from i18n key settings.status.savedRestartApply
    expect(screen.getByRole("button").closest("div")).toBeInTheDocument();
  });

  it("calls onRestart when button is clicked", () => {
    const onRestart = vi.fn();
    render(<RestartBanner visible onRestart={onRestart} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("disables the button while restarting", () => {
    render(<RestartBanner visible isRestarting onRestart={() => {}} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows different button text while isRestarting=true vs false", () => {
    const { rerender } = render(
      <RestartBanner visible isRestarting={false} onRestart={() => {}} />,
    );
    const idleText = screen.getByRole("button").textContent ?? "";

    rerender(<RestartBanner visible isRestarting onRestart={() => {}} />);
    const restartingText = screen.getByRole("button").textContent ?? "";

    expect(idleText).not.toBe(restartingText);
  });
});
