import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/i18n";
import { FileEditGroup } from "@/components/thread/activity/FileEditRow";
import { coalesceActivityMessages } from "@/components/thread/activity/activity-message-model";
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

  it("renders and expands a local file diff", async () => {
    render(
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
    expect(screen.getByLabelText("Edited src/demo.ts")).toBeInTheDocument();
    expect(screen.getByLabelText("+1")).toBeInTheDocument();
    expect(screen.getByLabelText("-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show diff for src/demo.ts" }));
    expect(await screen.findByText("const value = 2;")).toBeInTheDocument();
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

  it("coalesces one tool start/end pair before rendering", () => {
    const messages = coalesceActivityMessages([
      {
        id: "start",
        role: "tool",
        kind: "trace",
        content: "read_file({\"path\":\"a.ts\"})",
        traces: ["read_file({\"path\":\"a.ts\"})"],
        toolEvents: [{
          call_id: "call-1",
          name: "read_file",
          phase: "start",
          arguments: { path: "a.ts" },
        }],
        createdAt: 1,
        turnId: "turn-1",
      },
      {
        id: "end",
        role: "tool",
        kind: "trace",
        content: "read_file({ \"path\": \"a.ts\" })",
        traces: ["read_file({ \"path\": \"a.ts\" })"],
        toolEvents: [{
          call_id: "call-1",
          name: "read_file",
          phase: "end",
          arguments: { path: "a.ts" },
        }],
        createdAt: 2,
        turnId: "turn-1",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].traces).toHaveLength(1);
    expect(messages[0].toolEvents).toHaveLength(1);
    expect(messages[0].toolEvents?.[0].phase).toBe("end");
  });

  it("shows file edit failures", () => {
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

    expect(screen.getByLabelText("Could not edit src/demo.ts")).toBeInTheDocument();
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
