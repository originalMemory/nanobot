import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import {
  ModelsSection,
  type AgentSettingsDraft,
} from "@/components/settings/ModelsSection";
import type { SettingsPayload } from "@/lib/types";

const MODEL = "openai-codex/gpt-5.6-terra";

function makeSettings(): SettingsPayload {
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

describe("model settings", () => {
  it("does not expose auxiliary vision settings", () => {
    renderModels(makeSettings());

    expect(screen.queryByRole("switch", { name: "Vision assistance" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. gemini-2.5-flash")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
