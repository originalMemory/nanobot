import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { TtsSection } from "@/components/settings/TtsSection";
import type { SettingsPayload } from "@/lib/types";

const settings = {
  tts: {
    mode: "agent",
    preset: "default",
    voice: "voice-1",
    presets: [{ id: "default", label: "Default", voices: [{ id: "voice-1", label: "Voice" }] }],
  },
} as unknown as SettingsPayload;

describe("TtsSection system media setting", () => {
  it("loads and saves the Electron-local toggle", async () => {
    const getEnabled = vi.fn().mockResolvedValue(true);
    const getSupport = vi.fn().mockResolvedValue("system");
    const setEnabled = vi.fn().mockResolvedValue(false);
    Object.defineProperty(window, "electronAPI", {
      value: { systemMedia: { getEnabled, getSupport, setEnabled } },
      configurable: true,
    });

    render(
      <TtsSection
        settings={settings}
        token="token"
        apiBase="http://127.0.0.1:8765"
        onSaved={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "Pause supported media players while speaking",
    });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);

    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
    expect(toggle).not.toBeChecked();
  });
});
