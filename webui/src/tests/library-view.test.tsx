import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LibraryView } from "@/components/library/LibraryView";
import type { LibraryPayload } from "@/lib/api";

const fetchLibrary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), fetchLibrary }));
vi.mock("@/providers/ClientProvider", () => ({ useClient: () => ({ getToken: () => "test-token" }) }));
vi.mock("@/components/MarkdownText", () => ({ MarkdownText: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/CodeBlock", () => ({ CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre> }));
const listing: LibraryPayload = { kind: "directory", root: "/workspace", path: "", truncated: false, entries: [{ name: "README.md", kind: "file" }, { name: "memory", kind: "dir" }] };
const file: LibraryPayload = { kind: "text", root: "/workspace", path: "README.md", content: "Rendered note", raw_content: "Original source", language: "markdown", frontmatter: "tag: daily", size: 40, truncated: false, image_sources: {}, images_omitted: 0 };
beforeEach(() => {
  fetchLibrary.mockReset();
  localStorage.removeItem("nanobot.library.workspace.selection");
  localStorage.removeItem("nanobot.library.notes.selection");
});

it("expands directories in place and preserves the preview while collapsing them", async () => {
  fetchLibrary.mockImplementation(async (_token, _source, action, path) => action === "list"
    ? path === "memory" ? { ...listing, path, entries: [{ name: "MEMORY.md", kind: "file" }] } : listing
    : { ...file, path });
  const back = vi.fn();
  render(<LibraryView source="workspace" onBack={back} />);
  const directory = await screen.findByRole("button", { name: "memory" });
  fireEvent.click(directory);
  fireEvent.click(await screen.findByRole("button", { name: "MEMORY.md" }));
  await screen.findByText("Rendered note");
  expect(screen.getByRole("button", { name: "README.md" })).toBeInTheDocument();
  expect(directory).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(directory);
  expect(screen.queryByRole("button", { name: "MEMORY.md" })).toBeNull();
  expect(screen.getByText("Rendered note")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(screen.getByText("Original source")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
  expect(back).toHaveBeenCalledOnce();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Today’s diary" })).toBeNull();
});

it("opens the quick note switcher with Cmd/Ctrl+O and selects a document", async () => {
  const target = "网页剪藏/ACG/target.md";
  fetchLibrary.mockImplementation(async (_token, _source, action, path) => {
    if (action === "index") return { kind: "index", root: "/workspace", path: "", truncated: false, documents: [target, "生活/other.md"] };
    return action === "list" ? listing : { ...file, path };
  });
  render(<LibraryView source="notes" onBack={vi.fn()} />);
  await screen.findByRole("button", { name: "memory" });
  fireEvent.keyDown(document, { key: "o", metaKey: true });
  const input = await screen.findByRole("textbox", { name: "Quick open note" });
  fireEvent.change(input, { target: { value: "网页 target" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(fetchLibrary).toHaveBeenCalledWith("test-token", "notes", "read", target, expect.anything()));
});

it("reveals today's diary by expanding its ancestor directories", async () => {
  const target = "日记/2026/09/2026-09-18 周五.md";
  fetchLibrary.mockImplementation(async (_token, _source, action, path) => {
    if (action === "today") return { ...file, path: target, images_omitted: 1 };
    const names: Record<string, string> = { "": "日记", "日记": "2026", "日记/2026": "09", "日记/2026/09": "2026-09-18 周五.md" };
    return { ...listing, path, entries: [{ name: names[path], kind: path === "日记/2026/09" ? "file" : "dir" }] };
  });
  render(<LibraryView source="notes" onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Today’s diary" }));
  await screen.findByText("Rendered note");
  for (const name of ["日记", "2026", "09"]) expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "2026-09-18 周五.md" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("status")).toHaveTextContent("1 local image");
  expect(localStorage.getItem("nanobot.library.notes.selection")).toBe(target);
});

it("restores the selected file independently for each library", async () => {
  localStorage.setItem("nanobot.library.workspace.selection", "memory/MEMORY.md");
  fetchLibrary.mockImplementation(async (_token, _source, action, path) => action === "read" ? { ...file, path }
    : path ? { ...listing, path, entries: [{ name: "MEMORY.md", kind: "file" }] } : listing);
  render(<LibraryView source="workspace" onBack={vi.fn()} />);
  await screen.findByText("Rendered note");
  expect(screen.getByRole("button", { name: "memory" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "MEMORY.md" })).toHaveAttribute("aria-current", "page");
});

it("ignores an old directory response after switching independent library pages", async () => {
  let finish: (value: LibraryPayload) => void = () => {};
  fetchLibrary.mockImplementation((_token, source) => source === "workspace"
    ? new Promise<LibraryPayload>((resolve) => { finish = resolve; })
    : Promise.resolve({ ...listing, root: "/note", entries: [{ name: "Diary.md", kind: "file" }] }));
  const view = render(<LibraryView key="workspace" source="workspace" onBack={vi.fn()} />);
  view.rerender(<LibraryView key="notes" source="notes" onBack={vi.fn()} />);
  await screen.findByRole("button", { name: "Diary.md" });
  await act(async () => { finish(listing); });
  expect(screen.queryByRole("button", { name: "README.md" })).toBeNull();
  await waitFor(() => expect(fetchLibrary).toHaveBeenCalledWith("test-token", "notes", "index", "", expect.anything()));
});
