import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { DeskPetSection } from "@/components/settings/DeskPetSection";
import { PsbSection } from "@/components/settings/PsbSection";
import type { SettingsPayload } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  deletePsbModel: vi.fn(),
}));

const baseSettings = {
  deskPet: {
    tha: {
      config: {
        enabledEmotions: false,
        enabledMouthSync: false,
        windowWidth: 540,
        windowHeight: 540,
        audioDelayMs: 150,
      },
      model: { available: false, format: "", path: "" },
      motions: [],
      emotions: [],
    },
    psb: {
      autoShow: false,
      selectedModelId: "demo",
      followMouse: true,
      enabledResponseTags: true,
      showResponseTags: false,
      models: [
        {
          modelId: "demo",
          name: "Demo",
          format: "psb",
          compatible: true,
          translationStatus: "done",
        },
      ],
    },
  },
} as unknown as SettingsPayload;

const psbSectionProps = {
  settings: baseSettings,
  token: "tok",
  apiBase: "http://127.0.0.1:8765",
  onSave: vi.fn(),
  onRefreshSettings: vi.fn(),
};

describe("DeskPetSection", () => {
  it("switches between PSB and THA tabs", () => {
    render(
      <DeskPetSection
        settings={baseSettings}
        token="tok"
        apiBase="http://127.0.0.1:8765"
        onSaveTha={vi.fn()}
        onSavePsb={vi.fn()}
        onRefreshSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("Models")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "THA" }));
    expect(screen.getByText("Behavior")).toBeInTheDocument();
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
  });
});

describe("PsbSection", () => {
  it("renders PSB toggles and model directory hint", () => {
    render(<PsbSection {...psbSectionProps} />);

    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getAllByText(/desk_pets\/psb/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByText(/config panel/i)).toBeInTheDocument();
  });

  it("calls onSave when autoShow toggled", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<PsbSection {...psbSectionProps} onSave={onSave} />);

    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);
    expect(onSave).toHaveBeenCalledWith({ autoShow: true });
  });

  it("selects model from the dropdown", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const settings = {
      ...baseSettings,
      deskPet: {
        ...baseSettings.deskPet,
        psb: {
          ...baseSettings.deskPet.psb,
          selectedModelId: "other",
          models: [
            {
              modelId: "demo",
              name: "Demo",
              format: "psb",
              compatible: true,
              translationStatus: "done",
            },
            {
              modelId: "other",
              name: "Other",
              format: "psb",
              compatible: true,
              translationStatus: "done",
            },
          ],
        },
      },
    } as unknown as SettingsPayload;

    render(<PsbSection {...psbSectionProps} settings={settings} onSave={onSave} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "demo" } });
    expect(onSave).toHaveBeenCalledWith({ selectedModelId: "demo" });
  });

  it("shows translation status without manual translate action", () => {
    const settings = {
      ...baseSettings,
      deskPet: {
        ...baseSettings.deskPet,
        psb: {
          ...baseSettings.deskPet.psb,
          models: [
            {
              modelId: "demo",
              name: "Demo",
              format: "psb",
              compatible: true,
              translationStatus: "translating",
            },
          ],
        },
      },
    } as unknown as SettingsPayload;

    render(<PsbSection {...psbSectionProps} settings={settings} />);

    expect(screen.getByText("Translating")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Translate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rescan" })).not.toBeInTheDocument();
  });

  it("loads and saves local window size", async () => {
    const getWindowState = vi.fn().mockResolvedValue({ width: 400, height: 500, scale: 1, opacity: 1 });
    const saveWindowState = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "electronAPI", {
      value: {
        psb: { getWindowState, saveWindowState, open: vi.fn() },
      },
      configurable: true,
    });

    render(<PsbSection {...psbSectionProps} />);

    await waitFor(() => {
      expect(getWindowState).toHaveBeenCalled();
    });
    expect(screen.getByText("Window size")).toBeInTheDocument();
    const widthInput = screen.getByDisplayValue("400");
    fireEvent.change(widthInput, { target: { value: "480" } });
    await waitFor(() => {
      expect(saveWindowState).toHaveBeenCalledWith({ width: 480, height: 500 });
    });
  });
});
