import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopWindowFrame } from "@/components/WindowTitleBar";

afterEach(() => { delete window.nanobotHost; });

it("uses lover window controls and follows native maximize state", async () => {
  let update: (value: boolean) => void = () => {};
  const action = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();
  window.nanobotHost = { windowControls: {
    isMac: false, read: async () => false, action,
    onState: (listener) => { update = listener; return unsubscribe; },
  } };
  const view = render(<DesktopWindowFrame>连接页或聊天</DesktopWindowFrame>);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
  act(() => update(true));
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(action.mock.calls.map(([value]) => value)).toEqual(["minimize", "maximize", "maximize", "close"]);
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("leaves browsers unchanged and reserves macOS traffic lights", async () => {
  const view = render(<DesktopWindowFrame>浏览器</DesktopWindowFrame>);
  expect(screen.queryByTestId("desktop-titlebar")).toBeNull();
  window.nanobotHost = { windowControls: { isMac: true, read: async () => false, action: vi.fn(), onState: () => () => {} } };
  view.rerender(<DesktopWindowFrame>macOS</DesktopWindowFrame>);
  await act(async () => {});
  expect(screen.getByTestId("desktop-titlebar")).toHaveClass("pl-[78px]");
  expect(screen.queryByRole("button")).toBeNull();
});
