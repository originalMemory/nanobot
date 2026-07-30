import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/i18n";
import { summarizeFileEdits } from "@/components/thread/AgentActivityCluster";
import { FileEditGroup } from "@/components/thread/activity/FileEditRow";
import { mergeFileEdits } from "@/hooks/useNanobotStream";
import { codeLanguageFromPath } from "@/lib/code-language";
import { parseRenderableFileDiff } from "@/lib/file-diff";
import type { UIFileEdit } from "@/lib/types";

const diff = {
  format: "unified",
  text: [
    "--- src/demo.ts",
    "+++ src/demo.ts",
    "@@ -1,2 +1,2 @@",
    "-const value = 1;",
    "+const value = 2;",
    " keep();",
  ].join("\n"),
};

describe("file diff activity", () => {
  it("parses unified line numbers and kinds", () => {
    const hunks = parseRenderableFileDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { kind: "delete", old_lineno: 1, new_lineno: null, content: "const value = 1;" },
      { kind: "add", old_lineno: null, new_lineno: 1, content: "const value = 2;" },
      { kind: "context", old_lineno: 2, new_lineno: 2, content: "keep();" },
    ]);
    expect(codeLanguageFromPath("src/demo.ts")).toBe("typescript");
  });

  it("only offers expansion when a renderable diff exists", () => {
    const { rerender } = render(
      <FileEditGroup
        edits={[{
          key: "demo",
          path: "src/demo.ts",
          added: 1,
          deleted: 1,
          approximate: false,
          binary: false,
          status: "done",
          pending: false,
          diff,
        }]}
      />,
    );
    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();

    rerender(
      <FileEditGroup
        edits={[{
          key: "legacy",
          path: "legacy.txt",
          added: 1,
          deleted: 0,
          approximate: false,
          binary: false,
          status: "done",
          pending: false,
        }]}
      />,
    );
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-expanded");
  });

  it("keeps every file from one multi-file tool call", () => {
    const pending = fileEdit({ path: "", pending: true, status: "editing" });
    const merged = mergeFileEdits([pending], [
      fileEdit({ path: "src/a.ts", added: 1 }),
      fileEdit({ path: "src/b.ts", added: 2 }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((edit) => edit.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(merged.map((edit) => edit.added)).toEqual([1, 2]);
    expect(merged.every((edit) => !edit.pending)).toBe(true);
  });

  it("keeps counts aligned with each edit diff for repeated paths", () => {
    const firstDiff = { ...diff, text: diff.text.replaceAll("value", "first") };
    const secondDiff = { ...diff, text: diff.text.replaceAll("value", "second") };
    const summaries = summarizeFileEdits([
      fileEdit({ call_id: "call-1", path: "src/demo.ts", added: 1, diff: firstDiff }),
      fileEdit({ call_id: "call-2", path: "src/demo.ts", added: 4, diff: secondDiff }),
    ], false);

    expect(summaries).toHaveLength(2);
    expect(summaries.map((edit) => [edit.added, edit.diff?.text])).toEqual([
      [1, firstDiff.text],
      [4, secondDiff.text],
    ]);
  });

  it("shows file edit failures and their error", () => {
    render(
      <FileEditGroup
        edits={[{
          key: "failed",
          path: "src/demo.ts",
          added: 0,
          deleted: 0,
          approximate: false,
          binary: false,
          status: "error",
          pending: false,
          error: "Error: permission denied",
        }]}
      />,
    );

    expect(screen.getByText("Edit failed")).toBeInTheDocument();
    expect(screen.getByText("permission denied")).toBeInTheDocument();
  });
});

function fileEdit(overrides: Partial<UIFileEdit>): UIFileEdit {
  return {
    call_id: "call-patch",
    tool: "apply_patch",
    path: "src/demo.ts",
    added: 0,
    deleted: 0,
    status: "done",
    ...overrides,
  };
}
