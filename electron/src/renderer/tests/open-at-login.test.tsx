import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import type { LocalPreferences } from "@/components/settings/shared";

vi.mock("@/lib/env", () => ({ isElectron: true }));

const getOpenAtLogin = vi.fn();
const setOpenAtLogin = vi.fn();

const localPrefs: LocalPreferences = {
  density: "comfortable",
  activityMode: "auto",
  codeWrap: true,
  brandLogos: true,
};

describe("open at login setting", () => {
  beforeEach(() => {
    getOpenAtLogin.mockReset();
    setOpenAtLogin.mockReset();
    getOpenAtLogin.mockResolvedValue({ available: true, enabled: false, status: "not-registered" });
    setOpenAtLogin.mockResolvedValue({ available: true, enabled: true, status: "enabled" });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        platform: { isMac: true, isWindows: false },
        app: { getOpenAtLogin, setOpenAtLogin },
        wallpaper: {
          getConfig: vi.fn().mockResolvedValue({ url: "", intervalMinutes: 1 }),
          setConfig: vi.fn(),
        },
        shortcut: {
          getRaiseInbox: vi.fn().mockResolvedValue("CmdOrCtrl+Shift+E"),
          setRaiseInbox: vi.fn(),
          setRaiseInboxRecording: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
  });

  it("reads the system state and updates the login item", async () => {
    render(
      <AppearanceSection
        theme="light"
        onThemeChange={vi.fn()}
        localPrefs={localPrefs}
        onLocalPrefsChange={vi.fn()}
      />,
    );

    const toggle = await screen.findByRole("switch", { name: "Open at login" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    await waitFor(() => expect(setOpenAtLogin).toHaveBeenCalledWith(true));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("shows the macOS approval requirement", async () => {
    getOpenAtLogin.mockResolvedValue({
      available: true,
      enabled: true,
      status: "requires-approval",
    });

    render(
      <AppearanceSection
        theme="light"
        onThemeChange={vi.fn()}
        localPrefs={localPrefs}
        onLocalPrefsChange={vi.fn()}
      />,
    );

    expect(await screen.findByText(/System Settings.*Login Items/)).toBeInTheDocument();
  });
});
