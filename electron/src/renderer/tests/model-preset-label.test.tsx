import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { ModelPresetPicker } from "@/components/settings/shared";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import type { SettingsPayload } from "@/lib/types";

const MODEL = "openai-codex/gpt-5.6-terra";

function makeSettings(label: string): SettingsPayload {
  return {
    agent: {
      model: MODEL,
      provider: "openai_codex",
      resolved_provider: "openai_codex",
      model_preset: "gpt-5-6-terra",
    },
    model_presets: [
      {
        name: "gpt-5-6-terra",
        label,
        active: true,
        is_default: false,
        model: MODEL,
        provider: "openai_codex",
      },
    ],
    providers: [
      {
        name: "openai_codex",
        label: "OpenAI Codex",
        configured: true,
      },
    ],
  } as SettingsPayload;
}

describe("Electron model preset labels", () => {
  it("shows the preset label before the model ID in Settings", () => {
    const settings = makeSettings("GPT-5.6 Terra");
    render(
      <ModelPresetPicker
        presets={settings.model_presets}
        value="gpt-5-6-terra"
        settings={settings}
        draftModel={MODEL}
        draftProvider="openai_codex"
        showProviderLogos={false}
        onChange={vi.fn()}
        onCreateConfiguration={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button");
    expect(trigger).toHaveTextContent("GPT-5.6 Terra");
    expect(trigger).toHaveTextContent(MODEL);
  });

  it("shows the active preset label in the thread composer", () => {
    const settings = makeSettings("GPT-5.6 Terra");
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelSettings={settings}
        onModelPresetSelect={vi.fn()}
      />,
    );

    const trigger = screen.getByTitle(`${MODEL} · OpenAI Codex`);
    expect(trigger).toHaveTextContent("GPT-5.6 Terra");
    expect(trigger).not.toHaveTextContent(MODEL);
  });

  it("falls back to the model ID when the preset label is empty", () => {
    const settings = makeSettings("");
    render(
      <ModelPresetPicker
        presets={settings.model_presets}
        value="gpt-5-6-terra"
        settings={settings}
        draftModel={MODEL}
        draftProvider="openai_codex"
        showProviderLogos={false}
        onChange={vi.fn()}
        onCreateConfiguration={vi.fn()}
      />,
    );

    expect(screen.getByRole("button")).toHaveTextContent(MODEL);
  });
});
