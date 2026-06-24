import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PsbSection } from "@/components/settings/PsbSection";
import type { SettingsPayload } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  deletePsbModel: vi.fn(),
  rescanPsbModel: vi.fn(),
  retryPsbTranslation: vi.fn(),
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

describe("PsbSection", () => {
  it("renders PSB toggles and model directory hint", () => {
    render(
      <PsbSection
        settings={baseSettings}
        token="tok"
        apiBase="http://127.0.0.1:8765"
        onSave={vi.fn()}
        onRefreshSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("PSB Desk Pet")).toBeInTheDocument();
    expect(screen.getAllByText(/desk_pets\/psb/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "打开" })).toBeInTheDocument();
    expect(screen.getByText(/配置面板/)).toBeInTheDocument();
  });

  it("calls onSave when autoShow toggled", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <PsbSection
        settings={baseSettings}
        token="tok"
        apiBase="http://127.0.0.1:8765"
        onSave={onSave}
        onRefreshSettings={vi.fn()}
      />,
    );

    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);
    expect(onSave).toHaveBeenCalledWith({ autoShow: true });
  });

  it("shows translate button when translation is pending", () => {
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
              translationStatus: "pending",
            },
          ],
        },
      },
    } as unknown as SettingsPayload;

    render(
      <PsbSection
        settings={settings}
        token="tok"
        apiBase="http://127.0.0.1:8765"
        onSave={vi.fn()}
        onRefreshSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("待翻译")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "翻译" })).toBeInTheDocument();
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

    render(
      <PsbSection
        settings={baseSettings}
        token="tok"
        apiBase="http://127.0.0.1:8765"
        onSave={vi.fn()}
        onRefreshSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(getWindowState).toHaveBeenCalled();
    });
    expect(screen.getByText("窗口")).toBeInTheDocument();
    const widthInput = screen.getByDisplayValue("400");
    fireEvent.change(widthInput, { target: { value: "480" } });
    await waitFor(() => {
      expect(saveWindowState).toHaveBeenCalledWith({ width: 480, height: 500 });
    });
  });

  it("shows message when translation fails", async () => {
    const { retryPsbTranslation } = await import("@/lib/api");
    vi.mocked(retryPsbTranslation).mockResolvedValue({
      model: {
        modelId: "demo",
        name: "Demo",
        format: "psb",
        compatible: true,
        translationStatus: "failed",
        timelines: [],
        expressions: [],
        faceVariables: [],
        fadeVariables: [],
        initialState: { timeline: "", expression: "", face: {}, fade: {} },
      },
    });

    const settings = {
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
              translationStatus: "failed",
            },
          ],
        },
      },
    } as unknown as SettingsPayload;

    render(
      <PsbSection
        settings={settings}
        token="tok"
        apiBase="http://127.0.0.1:8765"
        onSave={vi.fn()}
        onRefreshSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重试翻译" }));
    await waitFor(() => {
      expect(screen.getByText(/翻译失败/)).toBeInTheDocument();
    });
  });
});
