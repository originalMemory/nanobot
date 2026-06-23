import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { SettingsLayout } from "@/components/settings/SettingsLayout";

function renderLayout(props?: Partial<React.ComponentProps<typeof SettingsLayout>>) {
  const onSelectSection = vi.fn();
  const onBack = vi.fn();
  render(
    <SettingsLayout
      activeSection="overview"
      onSelectSection={onSelectSection}
      onBack={onBack}
      {...props}
    >
      <div>content</div>
    </SettingsLayout>,
  );
  return { onSelectSection, onBack };
}

describe("SettingsLayout", () => {
  it("renders all 9 section nav buttons", () => {
    renderLayout();
    const navLabels = [
      "Overview",
      "Appearance",
      "Models",
      "Image",
      "Web",
      "Apps",
      "Runtime",
      "Desk Pet",
      "Advanced",
    ];
    for (const label of navLabels) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the active section with aria-current=page", () => {
    renderLayout({ activeSection: "deskPet" });
    expect(screen.getByRole("button", { name: "Desk Pet" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Overview" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("calls onSelectSection when a nav button is clicked", () => {
    const { onSelectSection } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Desk Pet" }));
    expect(onSelectSection).toHaveBeenCalledWith("deskPet");
  });

  it("calls onBack when back button is clicked", () => {
    const { onBack } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("renders children in the content area", () => {
    renderLayout();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("shows loading state instead of children", () => {
    renderLayout({ loading: true });
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("shows error state when error is provided", () => {
    renderLayout({ error: "connection failed" });
    expect(screen.getByText("connection failed")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });
});
