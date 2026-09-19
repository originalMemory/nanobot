import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTheme } from "@/hooks/useTheme";

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.removeItem("nanobot-webui.theme");
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;

    const themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    themeColor.content = "#ffffff";
    themeColor.dataset.themeColorLight = "#ffffff";
    themeColor.dataset.themeColorDark = "#303030";
    document.head.append(themeColor);
  });

  afterEach(() => {
    document.querySelector('meta[name="theme-color"]')?.remove();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;
    localStorage.removeItem("nanobot-webui.theme");
  });

  it("keeps browser chrome in sync with the selected app theme", () => {
    localStorage.setItem("nanobot-webui.theme", "dark");
    const { result } = renderHook(useTheme);
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

    expect(document.documentElement).toHaveClass("dark");
    expect(themeColor?.content).toBe("#303030");

    act(() => result.current.setTheme("light"));

    expect(document.documentElement).not.toHaveClass("dark");
    expect(themeColor?.content).toBe("#ffffff");
    expect(localStorage.getItem("nanobot-webui.theme")).toBe("light");
  });
  it("restores a custom palette while exposing its light/dark mode to code highlighting", () => {
    localStorage.setItem("nanobot-webui.theme", "midnight");
    const { result } = renderHook(useTheme);
    expect(result.current.theme).toBe("dark");
    expect(result.current.selectedTheme).toBe("midnight");
    expect(document.documentElement.dataset.theme).toBe("midnight");
    expect(document.documentElement).toHaveClass("dark");
    act(() => result.current.setTheme("desert"));
    expect(result.current.theme).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("nanobot-webui.theme")).toBe("desert");
    act(() => result.current.toggle());
    expect(result.current.selectedTheme).toBe("dark");
  });

  it("reads and writes the original Electron theme store key", async () => {
    const previous = window.nanobotHost;
    const config = { get: vi.fn(async () => 'ink'), set: vi.fn(async () => {}) };
    window.nanobotHost = { config };
    const view = renderHook(useTheme);
    try {
      await waitFor(() => expect(view.result.current.selectedTheme).toBe('ink'));
      expect(config.set).not.toHaveBeenCalled();
      act(() => view.result.current.setTheme('midnight'));
      expect(config.set).toHaveBeenCalledWith('appearance.theme', 'midnight');
    } finally {
      view.unmount();
      if (previous) window.nanobotHost = previous;
      else delete window.nanobotHost;
    }
  });

});
