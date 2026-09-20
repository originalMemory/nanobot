import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceSettings } from "@/components/settings/overview/OverviewSettings";
import { setAppLanguage } from "@/i18n";
import { DEFAULT_LOCAL_PREFS } from "@/lib/local-preferences";

afterEach(() => { delete window.nanobotHost; });

it("offers all nine desktop themes and selects the requested palette", async () => {
  window.nanobotHost = { fixedChatId: "desktop" };
  const select = vi.fn();
  render(<AppearanceSettings theme="dark" selectedTheme="midnight"
    onToggleTheme={vi.fn()} onSelectTheme={select} localPrefs={DEFAULT_LOCAL_PREFS}
    onChangeLocalPrefs={vi.fn()} />);
  const themes = screen.getByRole("combobox", { name: "Theme" });
  expect(themes).toHaveTextContent("Midnight");
  fireEvent.keyDown(themes, { key: "ArrowDown" });
  expect(await screen.findAllByRole("option")).toHaveLength(9);
  fireEvent.click(screen.getByRole("option", { name: "Desert" }));
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
    const themes = screen.getByRole("combobox", { name: "主题" });
    expect(themes).toHaveTextContent("深海蓝");
    fireEvent.keyDown(themes, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "棉花糖" })).toBeVisible();
    expect(screen.getByRole("option", { name: "云石白" })).toBeVisible();
    expect(screen.getByRole("option", { name: "石墨灰" })).toBeVisible();
  } finally {
    view.unmount();
    await act(async () => { await setAppLanguage("en"); });
  }
});
