import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Sidebar } from "@/components/Sidebar";

vi.mock("@/components/ConnectionBadge", () => ({ ConnectionBadge: () => null }));
afterEach(() => { cleanup(); delete window.nanobotHost; });

function props(): ComponentProps<typeof Sidebar> {
  return {
    sessions: [{ key: "websocket:old", channel: "websocket", chatId: "old", title: "Old topic", preview: "", createdAt: "", updatedAt: "" }],
    activeKey: "websocket:desktop", loading: false, newChatActive: false,
    onNewChat: vi.fn(), onSelect: vi.fn(), onRequestDelete: vi.fn(),
    onTogglePin: vi.fn(), onRequestRename: vi.fn(), onToggleArchive: vi.fn(),
    onToggleGroup: vi.fn(), onRequestRenameProject: vi.fn(), onNewChatInProject: vi.fn(),
    onOpenSettings: vi.fn(), onOpenApps: vi.fn(), onOpenSkills: vi.fn(),
    onOpenAutomations: vi.fn(), onOpenChannels: vi.fn(), onOpenSearch: vi.fn(), onToggleArchived: vi.fn(),
  };
}

it.each([false, true])("桌面侧栏只保留统一入口，折叠=%s", (collapsed) => {
  const callbacks = props();
  render(<Sidebar {...callbacks} fixedChatKey="websocket:desktop" collapsed={collapsed} />);
  const inbox = screen.getByRole("button", { name: "Chat" });
  fireEvent.click(inbox);
  expect(callbacks.onSelect).toHaveBeenCalledWith("websocket:desktop");
  expect(screen.queryByText("Old topic")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /New topic/i })).not.toBeInTheDocument();
  expect(callbacks.onRequestDelete).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /Settings/i })).toBeInTheDocument();
});

it("普通浏览器保留旧话题列表", () => {
  render(<Sidebar {...props()} />);
  expect(screen.getByText("Old topic")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Quit app" })).not.toBeInTheDocument();
});

it.each([false, true])("桌面底部完全退出调用宿主，折叠=%s", (collapsed) => {
  const quit = vi.fn().mockResolvedValue(undefined);
  window.nanobotHost = { quit };
  render(<Sidebar {...props()} fixedChatKey="websocket:desktop" collapsed={collapsed} />);
  fireEvent.click(screen.getByRole("button", { name: "Quit app" }));
  expect(quit).toHaveBeenCalledOnce();
});
