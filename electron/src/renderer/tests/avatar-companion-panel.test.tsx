import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { AvatarCompanionPanel } from "@/components/ui/AvatarCompanionPanel";

describe("AvatarCompanionPanel", () => {
  function installApi(reachable: boolean, overrides?: { livetalking?: boolean }) {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        config: {
          get: vi.fn(async () => ({
            enabled: true,
            livetalking: overrides?.livetalking ?? true,
            serverUrl: "http://127.0.0.1:8011",
            timeoutMs: 3000,
          })),
          set: vi.fn(),
        },
        livetalking: {
          localVideos: vi.fn(async () => ({ idle: ["file:///idle-1.mp4", "file:///idle-2.mp4"], working: ["file:///work.mp4"] })),
          checkHealth: vi.fn(async () => ({ reachable, lastCheckedAtMs: Date.now(), lastError: reachable ? null : "offline" })),
        },
      },
    });
  }

  it("shows retry in the header (no overlay) when LiveTalking is offline", async () => {
    installApi(false);

    const { container } = render(<AvatarCompanionPanel />);

    const retry = await screen.findByRole("button", { name: /retry|重试/i });
    expect(retry.getAttribute("title")).toContain("offline");
    expect(container.querySelector(".bg-black\\/55")).toBeNull();
    const video = await waitFor(() => {
      const element = container.querySelector("video[src]");
      expect(element).not.toBeNull();
      return element as HTMLVideoElement;
    });
    const firstSource = video.getAttribute("src");
    fireEvent.ended(video);
    const nextVideo = await waitFor(() => {
      const elements = [...container.querySelectorAll("video[src]")];
      expect(elements).toHaveLength(2);
      return elements.find((element) => element.getAttribute("src") !== firstSource) as HTMLVideoElement;
    });
    fireEvent.loadedData(nextVideo);
    await waitFor(() => expect(nextVideo).toHaveClass("opacity-100"));
    expect(video).toHaveClass("opacity-0");
  });

  it("shows a green status without opening WebRTC when LiveTalking is reachable", async () => {
    installApi(true);
    const { container } = render(<AvatarCompanionPanel />);

    await waitFor(() => expect(container.querySelector(".bg-emerald-500")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /retry|重试/i })).not.toBeInTheDocument();
  });

  it("stays green and skips health checks when the livetalking switch is off", async () => {
    installApi(false, { livetalking: false });
    const { container } = render(<AvatarCompanionPanel />);

    await waitFor(() => expect(container.querySelector(".bg-emerald-500")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /retry|重试/i })).not.toBeInTheDocument();
    expect(window.electronAPI.livetalking.checkHealth).not.toHaveBeenCalled();
  });
});
