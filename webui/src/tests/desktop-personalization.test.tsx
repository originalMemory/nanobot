import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DesktopAppearanceSettings } from "@/components/settings/DesktopAppearanceSettings";
import { DesktopAppearanceProvider, DesktopIdentity } from "@/providers/DesktopAppearanceProvider";
import type { DesktopAppearance } from "@/lib/runtime";
import { ClientProvider } from "@/providers/ClientProvider";
import { VoiceSettings } from "@/providers/VoiceProvider";
import { NanobotClient } from "@/lib/nanobot-client";

const config: DesktopAppearance = { name: "nanobot", icon: "🦊", source: "none", url: "", directory: "", order: "sequential", intervalMinutes: 1, opacity: 0.8, contentWidth: 1152 };
function fixture(overrides: Partial<DesktopAppearance> = {}) {
  const value = { ...config, ...overrides };
  const api = { read: vi.fn().mockResolvedValue(value), save: vi.fn(async (next: DesktopAppearance) => next),
    choose: vi.fn().mockResolvedValue(null), wallpaper: vi.fn().mockResolvedValue("data:image/jpeg;base64,Z29vZA==") };
  window.nanobotHost = { fixedChatId: "desktop", appearance: api };
  return api;
}
function renderAppearance(children: React.ReactNode) {
  const client = new NanobotClient({ url: "ws://unused", reconnect: false });
  const mutate = vi.spyOn(client, "requestMutation").mockResolvedValue({});
  const fetchSettings = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    runtime_config: { "agents.defaults.bot_name": "nanobot", "agents.defaults.bot_icon": "🦊" },
  }), { headers: { "content-type": "application/json" } }));
  const view = render(<ClientProvider client={client} token="test">
    <DesktopAppearanceProvider>{children}</DesktopAppearanceProvider>
  </ClientProvider>);
  return { view, mutate, fetchSettings };
}
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

it("voice settings retry loading and share save/cancel switch behavior", async () => {
  const settings = { preset: "minimax", voice: "one", presets: [{ id: "minimax", label: "MiniMax", voices: [{ id: "one", label: "Voice one" }] }] };
  const local = vi.fn(async () => ({ pauseSystemMedia: true, support: "system" }));
  window.nanobotHost = { voice: { active: vi.fn(async () => {}), settings: local } };
  const fetchSettings = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(new Response(JSON.stringify(settings)));
  const client = new NanobotClient({ url: "ws://unused", reconnect: false });
  const save = vi.spyOn(client, "requestMutation").mockResolvedValue(settings);
  const view = render(<ClientProvider client={client} token="test"><VoiceSettings /></ClientProvider>);
  try {
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const toggle = await screen.findByRole("switch", { name: "Pause system media while speaking" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(local).toHaveBeenCalledWith(false));
    expect(save).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  } finally { view.unmount(); fetchSettings.mockRestore(); save.mockRestore(); }
});
beforeEach(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => {
  delete window.nanobotHost;
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
});

it("saves display identity and keeps a failed draft for retry", async () => {
  const api = fixture();
  const mounted = renderAppearance(<><DesktopAppearanceSettings /><DesktopIdentity /></>);
  const input = await screen.findByLabelText("Display name");
  fireEvent.change(input, { target: { value: "Homura" } });
  api.save.mockRejectedValueOnce(new Error("disk full"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(input).toHaveValue("Homura");
  expect(screen.getByTestId("desktop-identity")).toHaveTextContent("nanobot");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByTestId("desktop-identity")).toHaveTextContent("Homura"));
  expect(api.save).toHaveBeenLastCalledWith(expect.not.objectContaining({ name: "Homura", icon: "🦊" }));
  expect(mounted.mutate).toHaveBeenCalledWith("settings.runtime_config.update", { values: {
    "agents.defaults.bot_name": "Homura", "agents.defaults.bot_icon": "🦊",
  } }, 20_000);
});

it("saves one shared conversation width for messages and the composer", async () => {
  const api = fixture();
  const mounted = renderAppearance(<DesktopAppearanceSettings />);
  const width = await screen.findByRole("spinbutton", { name: "Conversation width" });
  expect(width).toHaveValue(1152);
  expect(document.documentElement.style.getPropertyValue("--desktop-content-column-width"))
    .toBe("1152px");

  fireEvent.change(width, { target: { value: "960" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
    contentWidth: 960,
  })));
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--desktop-content-column-width"))
    .toBe("960px"));
  mounted.view.unmount();
  expect(document.documentElement.style.getPropertyValue("--desktop-content-column-width"))
    .toBe("");
});

it("uses the fixed gateway avatar and falls back to the icon", async () => {
  const api = fixture();
  renderAppearance(<><DesktopAppearanceSettings /><DesktopIdentity message /></>);
  const identity = await screen.findByTestId("desktop-identity");
  const image = identity.querySelector("img")!;
  expect(image).toHaveAttribute("src", "/api/avatar");
  expect(screen.queryByText("Avatar")).toBeNull();
  expect(screen.queryByRole("button", { name: "Choose…" })).toBeNull();
  fireEvent.error(image);
  expect(identity.querySelector("img")).toBeNull();
  expect(identity).toHaveTextContent("🦊");
  expect(identity.querySelector("span:last-child")).toHaveClass(
    "text-base", "text-rose-500/85", "dark:text-rose-300/85",
  );
  expect(api.choose).not.toHaveBeenCalled();
});

it("pauses wallpaper refresh while hidden, resumes on visibility, and cleans up", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const api = fixture({ source: "url", url: "https://example.com/image" });
  const { view } = renderAppearance(<DesktopIdentity />);
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
  renderAppearance(<DesktopAppearanceSettings />);
  await screen.findByTestId("desktop-wallpaper");
  api.wallpaper.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Next / refresh" }));
  await screen.findByRole("alert");
  expect(screen.getByTestId("desktop-wallpaper")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Source" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "Off" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByTestId("desktop-wallpaper")).toBeNull());
});
