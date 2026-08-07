import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import type { LocalPreferences } from "@/components/settings/shared";

vi.mock("@/lib/env", () => ({ isElectron: true }));

const setConfig = vi.fn();
const chooseDirectory = vi.fn();
const localPrefs: LocalPreferences = {
  density: "comfortable",
  activityMode: "auto",
  codeWrap: true,
  brandLogos: true,
};

describe("local wallpaper settings", () => {
  beforeEach(() => {
    setConfig.mockReset();
    chooseDirectory.mockReset();
    chooseDirectory.mockResolvedValue("C:\\Pictures\\Nanobot");
    setConfig.mockImplementation(async (config) => ({ ...config, localIndex: -1 }));
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        platform: { isMac: false, isWindows: true },
        app: {
          getOpenAtLogin: vi.fn().mockResolvedValue({
            available: true,
            enabled: false,
            status: "not-registered",
          }),
          setOpenAtLogin: vi.fn(),
        },
        shortcut: {
          getRaiseInbox: vi.fn().mockResolvedValue("CmdOrCtrl+Shift+E"),
          setRaiseInbox: vi.fn(),
          setRaiseInboxRecording: vi.fn().mockResolvedValue(undefined),
        },
        wallpaper: {
          getConfig: vi.fn().mockResolvedValue({
            source: "url",
            url: "https://example.com/image",
            directory: "",
            localOrder: "sequential",
            localIndex: 3,
            intervalMinutes: 1,
          }),
          setConfig,
          chooseDirectory,
        },
      },
    });
  });

  it("selects a local directory and saves random rotation", async () => {
    render(
      <AppearanceSection
        theme="light"
        onThemeChange={vi.fn()}
        localPrefs={localPrefs}
        onLocalPrefsChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Random" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Local folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(chooseDirectory).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByPlaceholderText("Image folder")).toHaveValue("C:\\Pictures\\Nanobot"));
    fireEvent.click(screen.getByRole("button", { name: "Random" }));
    const save = screen.getAllByRole("button", { name: "Save" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(save).toBeDefined();
    fireEvent.click(save as HTMLButtonElement);

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({
      source: "directory",
      url: "https://example.com/image",
      directory: "C:\\Pictures\\Nanobot",
      localOrder: "random",
      localIndex: 3,
      intervalMinutes: 1,
    }));
  });
});
