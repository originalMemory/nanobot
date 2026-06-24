import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PsbSection } from "@/components/settings/PsbSection";
import type { SettingsPayload } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  fetchPsbModelDetail: vi.fn(),
  deletePsbModel: vi.fn(),
  rescanPsbModel: vi.fn(),
  retryPsbTranslation: vi.fn(),
  savePsbInitialState: vi.fn(),
}));

import { fetchPsbModelDetail } from "@/lib/api";

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
    vi.mocked(fetchPsbModelDetail).mockResolvedValue({
      model: {
        modelId: "demo",
        name: "Demo",
        format: "psb",
        compatible: true,
        timelines: [{ label: "待機", labelZh: "待机", looping: true }],
        expressions: [],
        faceVariables: [],
        fadeVariables: [],
        initialState: { timeline: "待機", expression: "", face: {}, fade: {} },
      },
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

    expect(screen.getByText("PSB Desk Pet")).toBeInTheDocument();
    expect(screen.getAllByText(/desk_pets\/psb/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "打开" })).toBeInTheDocument();
  });

  it("loads model detail for initial state when a model is selected", async () => {
    vi.mocked(fetchPsbModelDetail).mockResolvedValue({
      model: {
        modelId: "demo",
        name: "Demo",
        format: "psb",
        compatible: true,
        timelines: [{ label: "待機", labelZh: "待机", looping: true }],
        expressions: [{ label: "微笑", labelZh: "微笑" }],
        faceVariables: [],
        fadeVariables: [],
        initialState: { timeline: "待機", expression: "", face: {}, fade: {} },
      },
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
      expect(fetchPsbModelDetail).toHaveBeenCalledWith("tok", "demo", "http://127.0.0.1:8765");
    });
    expect(screen.getByText("初始状态")).toBeInTheDocument();
  });

  it("calls onSave when autoShow toggled", () => {
    vi.mocked(fetchPsbModelDetail).mockResolvedValue({
      model: {
        modelId: "demo",
        name: "Demo",
        format: "psb",
        compatible: true,
        timelines: [],
        expressions: [],
        faceVariables: [],
        fadeVariables: [],
        initialState: { timeline: "", expression: "", face: {}, fade: {} },
      },
    });
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
    vi.mocked(fetchPsbModelDetail).mockResolvedValue({
      model: {
        modelId: "demo",
        name: "Demo",
        format: "psb",
        compatible: true,
        timelines: [],
        expressions: [],
        faceVariables: [],
        fadeVariables: [],
        initialState: { timeline: "", expression: "", face: {}, fade: {} },
      },
    });

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
});
