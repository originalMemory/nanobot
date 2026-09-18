import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DesktopAppearanceSettings } from "@/components/settings/DesktopAppearanceSettings";
import { DesktopAppearanceProvider, DesktopIdentity } from "@/providers/DesktopAppearanceProvider";
import type { DesktopAppearance } from "@/lib/runtime";

const config: DesktopAppearance = { name: "nanobot", icon: "🦊", source: "none", url: "", directory: "", order: "sequential", intervalMinutes: 1, opacity: 0.8 };
function fixture(overrides: Partial<DesktopAppearance> = {}) {
  const value = { ...config, ...overrides };
  const api = { read: vi.fn().mockResolvedValue(value), save: vi.fn(async (next: DesktopAppearance) => next),
    choose: vi.fn().mockResolvedValue(null), wallpaper: vi.fn().mockResolvedValue("data:image/jpeg;base64,Z29vZA==") };
  window.nanobotHost = { fixedChatId: "desktop", appearance: api };
  return api;
}
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
beforeEach(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => {
  delete window.nanobotHost;
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
});

it("saves display identity and keeps a failed draft for retry", async () => {
  const api = fixture();
  render(<DesktopAppearanceProvider><DesktopAppearanceSettings /><DesktopIdentity /></DesktopAppearanceProvider>);
  const input = await screen.findByLabelText("Display name");
  fireEvent.change(input, { target: { value: "Homura" } });
  api.save.mockRejectedValueOnce(new Error("disk full"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(input).toHaveValue("Homura");
  expect(screen.getByTestId("desktop-identity")).toHaveTextContent("nanobot");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByTestId("desktop-identity")).toHaveTextContent("Homura"));
  expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Homura" }));
});

it("uses the fixed gateway avatar and falls back to the icon", async () => {
  const api = fixture();
  render(<DesktopAppearanceProvider><DesktopAppearanceSettings /><DesktopIdentity /></DesktopAppearanceProvider>);
  const identity = await screen.findByTestId("desktop-identity");
  const image = identity.querySelector("img")!;
  expect(image).toHaveAttribute("src", "/api/avatar");
  expect(screen.queryByText("Avatar")).toBeNull();
  expect(screen.queryByRole("button", { name: "Choose…" })).toBeNull();
  fireEvent.error(image);
  expect(identity.querySelector("img")).toBeNull();
  expect(identity).toHaveTextContent("🦊");
  expect(api.choose).not.toHaveBeenCalled();
});

it("pauses wallpaper refresh while hidden, resumes on visibility, and cleans up", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const api = fixture({ source: "url", url: "https://example.com/image" });
  const view = render(<DesktopAppearanceProvider><DesktopIdentity /></DesktopAppearanceProvider>);
  await act(async () => {});
  expect(api.wallpaper).toHaveBeenCalledTimes(1);
  expect(document.documentElement.dataset.wallpaper).toBe("on");
  expect(document.documentElement.style.getPropertyValue("--desktop-panel-opacity")).toBe("0.8");
  visibility = "hidden";
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(api.wallpaper).toHaveBeenCalledTimes(1);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(api.wallpaper).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(document.documentElement.dataset.wallpaper).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(api.wallpaper).toHaveBeenCalledTimes(2);
});

it("retains the last wallpaper on refresh failure and exposes retry", async () => {
  const api = fixture({ source: "url", url: "https://example.com/image" });
  render(<DesktopAppearanceProvider><DesktopAppearanceSettings /></DesktopAppearanceProvider>);
  await screen.findByTestId("desktop-wallpaper");
  api.wallpaper.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Next / refresh" }));
  await screen.findByRole("alert");
  expect(screen.getByTestId("desktop-wallpaper")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Source"), { target: { value: "none" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByTestId("desktop-wallpaper")).toBeNull());
});
