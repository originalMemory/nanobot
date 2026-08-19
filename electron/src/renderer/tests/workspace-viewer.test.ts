import { describe, expect, it } from "vitest";

import {
  codeLanguageForPath,
  fileExtension,
  formatJsonIfPossible,
  formatJsonlIfPossible,
  formatStructuredJsonContent,
  joinWorkspacePath,
  MAX_JSONL_FORMAT_BYTES,
  previewModeForPath,
  todayDiaryPath,
  workspaceAncestorDirs,
  workspaceImageDataUrl,
} from "@/lib/workspaceViewer";

describe("workspaceViewer", () => {
  it("detects markdown preview mode", () => {
    expect(previewModeForPath("memory/MEMORY.md")).toBe("markdown");
    expect(previewModeForPath("notes.markdown")).toBe("markdown");
  });

  it("detects image preview mode", () => {
    expect(previewModeForPath("assets/icon.png")).toBe("image");
    expect(previewModeForPath("photo.JPEG")).toBe("image");
  });

  it("detects unsupported binary preview mode", () => {
    expect(previewModeForPath("doc.pdf")).toBe("unsupported");
    expect(previewModeForPath("icon.svg")).toBe("unsupported");
  });

  it("maps code languages by extension", () => {
    expect(codeLanguageForPath("script.py")).toBe("python");
    expect(codeLanguageForPath("run.sh")).toBe("bash");
    expect(codeLanguageForPath("memory/history.jsonl")).toBe("json");
    expect(fileExtension("a/b/config.json")).toBe("json");
  });

  it("formats valid json content", () => {
    const result = formatJsonIfPossible('{"a":1}');
    expect(result.language).toBe("json");
    expect(result.content).toContain('"a": 1');
  });

  it("formats jsonl line by line", () => {
    const result = formatJsonlIfPossible('{"a":1}\n{"b":[1,2]}');
    expect(result.language).toBe("json");
    expect(result.content).toContain('"a": 1');
    expect(result.content).toContain('"b": [\n    1,\n    2\n  ]');
  });

  it("skips jsonl formatting above size threshold", () => {
    const oversized = "x".repeat(MAX_JSONL_FORMAT_BYTES + 1);
    const result = formatJsonlIfPossible(oversized);
    expect(result.language).toBe("json");
    expect(result.content).toBe(oversized);
  });

  it("routes structured json formatting by extension", () => {
    const jsonl = formatStructuredJsonContent("memory/history.jsonl", '{"x":1}');
    expect(jsonl.content).toContain('"x": 1');
  });

  it("builds image data urls", () => {
    const url = workspaceImageDataUrl({
      path: "a.png",
      kind: "image",
      mime_type: "image/png",
      content_base64: "abc",
    });
    expect(url).toBe("data:image/png;base64,abc");
  });

  it("joins workspace paths", () => {
    expect(joinWorkspacePath("", "README.md")).toBe("README.md");
    expect(joinWorkspacePath("memory", "MEMORY.md")).toBe("memory/MEMORY.md");
  });

  it("lists ancestor directories for tree restore", () => {
    expect(workspaceAncestorDirs("README.md")).toEqual([]);
    expect(workspaceAncestorDirs("skills/SKILL.md")).toEqual(["skills"]);
    expect(workspaceAncestorDirs("skills/bills/SKILL.md")).toEqual(["skills", "skills/bills"]);
  });

  it("builds the fixed diary path for the configured timezone", () => {
    const instant = new Date("2026-07-12T01:30:00Z");
    expect(todayDiaryPath("Asia/Shanghai", instant)).toBe(
      "2026/07/2026-07-12 周日.md",
    );
    expect(todayDiaryPath("America/Los_Angeles", instant)).toBe(
      "2026/07/2026-07-11 周六.md",
    );
  });
});
