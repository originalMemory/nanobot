import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OverviewSettings } from "@/components/settings/overview/OverviewSettings";
import { settingsPayload } from "@/tests/settings-test-utils";

describe("OverviewSettings", () => {
  it("shows the active session model preset instead of the configured default", () => {
    const settings = settingsPayload();
    settings.model_presets.push({
      ...settings.model_presets[0],
      name: "deep",
      label: "Deep",
      active: false,
      model: "anthropic/claude-opus-4-1",
      provider: "anthropic",
      resolved_provider: "anthropic",
    });

    render(
      <OverviewSettings
        settings={settings}
        activeModelName="anthropic/claude-opus-4-1"
        activeModelPreset="deep"
        showBrandLogos={false}
        onSelectSection={vi.fn()}
      />,
    );

    expect(screen.getByText("anthropic/claude-opus-4-1")).toBeInTheDocument();
    expect(screen.getByText("anthropic · deep")).toBeInTheDocument();
    expect(screen.queryByText("openai/gpt-4o")).not.toBeInTheDocument();
  });
});
