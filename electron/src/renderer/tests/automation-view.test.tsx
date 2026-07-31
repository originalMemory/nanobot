import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import {
  AutomationView,
  formatAutomationInterval,
} from "@/components/automations/AutomationView";
import type { AutomationItem } from "@/lib/types";

const apiMocks = vi.hoisted(() => ({
  fetchAutomations: vi.fn(),
  runAutomationAction: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, ...apiMocks };
});

const ordinary: AutomationItem = {
  id: "daily",
  name: "Daily note",
  enabled: true,
  running: false,
  protected: false,
  schedule: {
    kind: "cron",
    at_ms: null,
    every_ms: null,
    expr: "0 9 * * *",
    tz: "Asia/Shanghai",
  },
  source: {
    kind: "agent_turn",
    channel: "websocket",
    to: "inbox:unified",
    session_key: "unified:default",
    deliver: true,
  },
  state: {
    next_run_at_ms: 1_800_000_000_000,
    last_run_at_ms: null,
    last_status: null,
    last_error: null,
  },
};

const system: AutomationItem = {
  ...ordinary,
  id: "system-heartbeat",
  name: "Heartbeat",
  protected: true,
  source: {
    ...ordinary.source,
    kind: "system_event",
  },
};

describe("AutomationView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats common repeat intervals compactly", () => {
    expect(formatAutomationInterval(60_000)).toBe("1m");
    expect(formatAutomationInterval(7_200_000)).toBe("2h");
    expect(formatAutomationInterval(172_800_000)).toBe("2d");
  });

  it("loads jobs and keeps system actions disabled", async () => {
    apiMocks.fetchAutomations.mockResolvedValue({ automations: [ordinary, system] });

    render(
      <AutomationView
        token="token"
        gatewayUrl="http://gateway"
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText("Daily note")).toBeInTheDocument();
    expect(screen.getByText("Heartbeat")).toBeInTheDocument();
    const pauseButtons = screen.getAllByRole("button", { name: "Pause" });
    expect(pauseButtons[0]).toBeEnabled();
    expect(pauseButtons[1]).toBeDisabled();
  });

  it("uses the returned server snapshot after pausing", async () => {
    apiMocks.fetchAutomations.mockResolvedValue({ automations: [ordinary] });
    apiMocks.runAutomationAction.mockResolvedValue({
      automations: [{ ...ordinary, enabled: false }],
    });

    render(
      <AutomationView
        token="token"
        gatewayUrl="http://gateway"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(apiMocks.runAutomationAction).toHaveBeenCalledWith(
        "token",
        "disable",
        "daily",
        "http://gateway",
      );
    });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });

  it("polls until a background run completes", async () => {
    const running = { ...ordinary, running: true };
    apiMocks.fetchAutomations
      .mockResolvedValueOnce({ automations: [running] })
      .mockResolvedValue({ automations: [ordinary] });

    render(
      <AutomationView
        token="token"
        gatewayUrl="http://gateway"
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    await waitFor(
      () => expect(apiMocks.fetchAutomations).toHaveBeenCalledTimes(2),
      { timeout: 2_500 },
    );
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });
});
