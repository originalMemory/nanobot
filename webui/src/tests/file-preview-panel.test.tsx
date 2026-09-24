import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewPanel } from "@/components/FilePreviewPanel";
import { setAppLanguage } from "@/i18n";
import { fetchFilePreview } from "@/lib/api";

vi.mock("@/components/CodeBlock", () => ({
  CodeBlock: ({
    code,
    language,
    highlight,
  }: {
    code: string;
    language?: string;
    highlight?: boolean;
  }) => (
    <pre
      data-testid="mock-code-block"
      data-language={language}
      data-highlight={String(highlight)}
    >
      {code}
    </pre>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchFilePreview: vi.fn(),
  };
});

describe("FilePreviewPanel", () => {
  beforeEach(async () => {
    await setAppLanguage("en");
    vi.mocked(fetchFilePreview).mockReset();
  });

  it("shows a compact breadcrumb with one file name and a visible close action", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(fetchFilePreview).mockResolvedValue({
      path: "/Users/hr/workspace/quicksort.py",
      display_path: "quicksort.py",
      language: "python",
      content: "print('ok')",
      truncated: false,
    });

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="quicksort.py"
        token="tok"
        onClose={onClose}
      />,
    );

    const codeBlock = await screen.findByTestId("mock-code-block");
    expect(codeBlock).toHaveTextContent("print('ok')");
    expect(codeBlock).toHaveAttribute("data-language", "python");
    expect(codeBlock).toHaveAttribute("data-highlight", "true");
    expect(screen.getByTestId("file-preview-breadcrumb")).toHaveTextContent("...");
    expect(screen.getByTestId("file-preview-breadcrumb")).toHaveTextContent("workspace");
    expect(screen.getByTestId("file-preview-title")).toHaveTextContent("quicksort.py");
    expect(screen.getAllByText("quicksort.py")).toHaveLength(1);

    const closeButton = screen.getByRole("button", { name: "Close file preview" });
    expect(closeButton).toBeVisible();

    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("updates translated chrome without refetching the open file", async () => {
    vi.mocked(fetchFilePreview).mockResolvedValue({
      path: "/workspace/notes.md",
      display_path: "notes.md",
      language: "markdown",
      content: "# Notes",
      truncated: false,
      library_source: "notes",
    });

    render(
      <FilePreviewPanel
        sessionKey="websocket:chat-1"
        path="notes.md"
        token="tok"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole("button", { name: "Source" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeVisible();
    expect(fetchFilePreview).toHaveBeenCalledTimes(1);

    await userEvent.setup().click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByTestId("mock-code-block")).toHaveTextContent("# Notes");

    await act(async () => {
      await setAppLanguage("zh-CN");
    });

    expect(fetchFilePreview).toHaveBeenCalledTimes(1);
  });

  it("renders note metadata and opens relative note links within the notes library", async () => {
    const onOpenFilePreview = vi.fn();
    vi.mocked(fetchFilePreview).mockResolvedValue({
      path: "/nas/ssd/note/网页剪藏/ACG/current.md",
      display_path: "/nas/ssd/note/网页剪藏/ACG/current.md",
      language: "markdown",
      content: "[Related](../科技/related.md)",
      raw_content: "---\ncategory: ACG\n---\n[Related](../科技/related.md)",
      properties: { category: "ACG" },
      library_source: "notes",
      library_root: "/nas/ssd/note",
      library_path: "网页剪藏/ACG/current.md",
      truncated: false,
    });

    render(<FilePreviewPanel sessionKey="websocket:chat-1" path="current.md" token="tok"
      onClose={() => {}} onOpenFilePreview={onOpenFilePreview} />);

    expect(await screen.findByRole("heading", { name: "current" })).toBeVisible();
    expect(screen.getByText("category")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "../科技/related.md" }));
    expect(onOpenFilePreview).toHaveBeenCalledWith("/nas/ssd/note/网页剪藏/科技/related.md");
  });
});
