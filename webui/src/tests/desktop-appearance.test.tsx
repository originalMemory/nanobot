import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceSettings } from "@/components/settings/overview/OverviewSettings";
import { setAppLanguage } from "@/i18n";
import { DEFAULT_LOCAL_PREFS } from "@/lib/local-preferences";

afterEach(() => { delete window.nanobotHost; });

it("offers all nine desktop themes and selects the requested palette", () => {
  window.nanobotHost = { fixedChatId: "desktop" };
  const select = vi.fn();
  const view = render(<AppearanceSettings theme="dark" selectedTheme="midnight"
    onToggleTheme={vi.fn()} onSelectTheme={select} localPrefs={DEFAULT_LOCAL_PREFS}
    onChangeLocalPrefs={vi.fn()} />);
  expect(view.container.querySelectorAll("[data-theme-choice]")).toHaveLength(9);
  expect(screen.getByRole("button", { name: "Midnight" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Desert" }));
  expect(select).toHaveBeenCalledWith("desert");
});

it("keeps the browser's light/dark control", () => {
  const toggle = vi.fn();
  const view = render(<AppearanceSettings theme="light" onToggleTheme={toggle}
    onSelectTheme={vi.fn()} localPrefs={DEFAULT_LOCAL_PREFS} onChangeLocalPrefs={vi.fn()} />);
  expect(view.container.querySelectorAll("[data-theme-choice]")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(toggle).toHaveBeenCalledOnce();
});

it("translates desktop theme names when switching to Chinese", async () => {
  window.nanobotHost = { fixedChatId: "desktop" };
  const view = render(<AppearanceSettings theme="dark" selectedTheme="midnight"
    onToggleTheme={vi.fn()} onSelectTheme={vi.fn()} localPrefs={DEFAULT_LOCAL_PREFS}
    onChangeLocalPrefs={vi.fn()} />);
  try {
    await act(async () => { await setAppLanguage("zh-CN"); });
    expect(screen.getByRole("button", { name: "深海蓝" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "棉花糖" })).toBeVisible();
    expect(screen.getByRole("button", { name: "云石白" })).toBeVisible();
    expect(screen.getByRole("button", { name: "石墨灰" })).toBeVisible();
  } finally {
    view.unmount();
    await act(async () => { await setAppLanguage("en"); });
  }
});
