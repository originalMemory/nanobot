import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import {
  ModelsSection,
  type AgentSettingsDraft,
} from "@/components/settings/ModelsSection";
import type { SettingsPayload } from "@/lib/types";

const MODEL = "openai-codex/gpt-5.6-terra";

function makeSettings(
  visionModel: string | null = null,
  visionProvider: string | null = null,
  visionEnabled = true,
): SettingsPayload {
  return {
    agent: {
      model: MODEL,
      provider: "openai_codex",
      resolved_provider: "openai_codex",
      has_api_key: true,
      model_preset: "codex-terra",
      max_tokens: 20_000,
      context_window_tokens: 1_000_000,
      temperature: 0.1,
      reasoning_effort: null,
      timezone: "Asia/Shanghai",
      bot_name: "nanobot",
      bot_icon: "🐈",
      bot_avatar_url: null,
      tool_hint_max_length: 40,
      vision_model: visionModel,
      vision_provider: visionProvider,
      vision_enabled: visionEnabled,
      max_messages: 120,
    },
    model_presets: [
      {
        name: "default",
        label: "Default",
        active: false,
        is_default: true,
        model: MODEL,
        provider: "openai_codex",
        max_tokens: 20_000,
        context_window_tokens: 1_000_000,
        temperature: 0.1,
        reasoning_effort: null,
        vision_model: null,
        vision_provider: null,
        vision_enabled: true,
      },
      {
        name: "codex-terra",
        label: "GPT-5.6 Terra",
        active: true,
        is_default: false,
        model: MODEL,
        provider: "openai_codex",
        max_tokens: 20_000,
        context_window_tokens: 1_000_000,
        temperature: 0.1,
        reasoning_effort: null,
        vision_model: visionModel,
        vision_provider: visionProvider,
        vision_enabled: visionEnabled,
      },
    ],
    providers: [
      {
        name: "openai_codex",
        label: "OpenAI Codex",
        configured: true,
      },
      {
        name: "gemini",
        label: "Gemini",
        configured: true,
      },
    ],
  } as SettingsPayload;
}

function renderModels(
  settings: SettingsPayload,
  onSaveModel: (draft: AgentSettingsDraft) => Promise<void> = vi.fn(),
) {
  return render(
    <ModelsSection
      settings={settings}
      showBrandLogos={false}
      imageProviderRestartPending={false}
      onSettingsUpdate={vi.fn()}
      onSaveModel={onSaveModel}
      onSaveProvider={vi.fn()}
      onCreateModelConfiguration={vi.fn()}
    />,
  );
}

describe("global vision assistance and Codex reasoning settings", () => {
  it("shows the shared vision settings and current preset switch", () => {
    renderModels(makeSettings("gemini-2.5-pro", "gemini", false));

    expect(screen.getByRole("switch", { name: "Vision assistance" })).not.toBeChecked();
    expect(screen.getByDisplayValue("gemini-2.5-pro")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gemini" })).toBeInTheDocument();
  });

  it("saves the global auxiliary model and preset switch", async () => {
    const user = userEvent.setup();
    const onSaveModel = vi.fn(async () => {});
    renderModels(makeSettings(), onSaveModel);

    await user.type(screen.getByPlaceholderText("e.g. gemini-2.5-flash"), "gemini-2.5-pro");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaveModel).toHaveBeenCalledWith(expect.objectContaining({
      modelPreset: "codex-terra",
      visionModel: "gemini-2.5-pro",
      visionProvider: "",
      visionEnabled: true,
    }));
  });

});
