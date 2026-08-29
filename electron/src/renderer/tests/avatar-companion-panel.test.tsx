import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { AvatarCompanionPanel } from "@/components/ui/AvatarCompanionPanel";

describe("AvatarCompanionPanel", () => {
  it("shows retry immediately when LiveTalking is offline", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        config: {
          get: vi.fn(async () => ({ enabled: true, serverUrl: "http://127.0.0.1:8011", timeoutMs: 3000 })),
          set: vi.fn(),
        },
        livetalking: {
          localVideos: vi.fn(async () => ({ idle: ["file:///idle-1.mp4", "file:///idle-2.mp4"], working: ["file:///work.mp4"] })),
          checkHealth: vi.fn(async () => ({ reachable: false, lastCheckedAtMs: Date.now(), lastError: "offline" })),
        },
      },
    });

    const { container } = render(<AvatarCompanionPanel />);

    expect(await screen.findByRole("button", { name: /retry|重试/i })).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
    const video = await waitFor(() => {
      const element = container.querySelector("video[src]");
      expect(element).not.toBeNull();
      return element as HTMLVideoElement;
    });
    const firstSource = video.getAttribute("src");
    fireEvent.ended(video);
    await waitFor(() => expect(video.getAttribute("src")).not.toBe(firstSource));
  });
});
