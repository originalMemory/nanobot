import { describe, expect, it } from "vitest";

import { parseEmojiColonQuery } from "@/lib/emoji-colon";
import {
  filterEmojiColonCandidates,
  getEmojiColonCandidates,
  unifiedToNative,
} from "@/lib/emoji-picker-data";

describe("parseEmojiColonQuery", () => {
  it("matches :shortcode at line start", () => {
    expect(parseEmojiColonQuery(":smi", 4)).toEqual({
      query: "smi",
      start: 0,
      end: 4,
    });
  });

  it("matches after whitespace", () => {
    expect(parseEmojiColonQuery("hi :wave", 8)).toEqual({
      query: "wave",
      start: 3,
      end: 8,
    });
  });

  it("matches Chinese query fragments", () => {
    expect(parseEmojiColonQuery(":笑", 2)).toEqual({
      query: "笑",
      start: 0,
      end: 2,
    });
  });

  it("matches full-width Chinese colon", () => {
    expect(parseEmojiColonQuery("：smi", 4)).toEqual({
      query: "smi",
      start: 0,
      end: 4,
    });
    expect(parseEmojiColonQuery("你好 ：笑", 5)).toEqual({
      query: "笑",
      start: 3,
      end: 5,
    });
  });

  it("ignores http:// style colons", () => {
    expect(parseEmojiColonQuery("http://x.com", 12)).toBeNull();
  });
});

describe("emoji-picker-react data", () => {
  it("converts unified codes to native emoji", () => {
    expect(unifiedToNative("1f600")).toBe("😀");
  });

  it("uses Chinese phrases and English shortcodes in zh mode", () => {
    const candidates = getEmojiColonCandidates(true);
    const grin = candidates.find((item) => item.native === "😀");
    const beaming = candidates.find((item) => item.unified === "1f601");
    expect(grin?.name).not.toHaveLength(1);
    expect(grin?.name).toMatch(/嘿嘿|笑脸/);
    expect(grin?.id).toMatch(/^[a-z_]+$/);
    expect(beaming?.id).toMatch(/^[a-z_]+$/);
  });

  it("filters by localized keywords", () => {
    const candidates = getEmojiColonCandidates(true);
    const grin = candidates.find((item) => item.native === "😀");
    expect(grin).toBeDefined();
    if (!grin) return;
    expect(
      filterEmojiColonCandidates(candidates, "嘿嘿", true).some(
        (item) => item.native === "😀",
      ),
    ).toBe(true);
    expect(
      filterEmojiColonCandidates(candidates, "grin", true).some(
        (item) => item.native === "😀",
      ),
    ).toBe(true);
  });
});
