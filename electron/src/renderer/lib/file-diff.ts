import { parsePatch } from "diff";

import type { UIFileDiff } from "@/lib/types";

export interface RenderableFileDiffLine {
  kind: "context" | "add" | "delete";
  old_lineno: number | null;
  new_lineno: number | null;
  content: string;
}

export interface RenderableFileDiffHunk {
  header: string;
  lines: RenderableFileDiffLine[];
}

export function hasRenderableFileDiff(diff?: UIFileDiff): boolean {
  return typeof diff?.text === "string" && diff.text.trim().length > 0;
}

export function parseRenderableFileDiff(diff: UIFileDiff): RenderableFileDiffHunk[] {
  if (!hasRenderableFileDiff(diff)) return [];
  try {
    return parsePatch(diff.text!).flatMap((file) =>
      file.hunks.map((hunk) => {
        let oldLineno = hunk.oldStart;
        let newLineno = hunk.newStart;
        const lines: RenderableFileDiffLine[] = [];
        for (const rawLine of hunk.lines) {
          if (rawLine.startsWith("\\")) continue;
          const marker = rawLine[0];
          const content = rawLine.slice(1);
          if (marker === "+") {
            lines.push({ kind: "add", old_lineno: null, new_lineno: newLineno++, content });
          } else if (marker === "-") {
            lines.push({ kind: "delete", old_lineno: oldLineno++, new_lineno: null, content });
          } else {
            lines.push({
              kind: "context",
              old_lineno: oldLineno++,
              new_lineno: newLineno++,
              content: marker === " " ? content : rawLine,
            });
          }
        }
        return {
          header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          lines,
        };
      }),
    );
  } catch {
    return [];
  }
}
