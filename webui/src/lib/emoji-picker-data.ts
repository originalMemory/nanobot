import type { EmojiData } from "emoji-picker-react/dist/types/exposedTypes";
import emojiDataEn from "emoji-picker-react/dist/data/emojis-en";
import emojiDataZh from "emoji-picker-react/dist/data/emojis-zh";

import {
  EMOJI_COLON_PALETTE_LIMIT,
  type EmojiColonCandidate,
} from "@/lib/emoji-colon";

interface EprSuggestedItem {
  unified: string;
  original: string;
  count: number;
}

interface EmojiPickerRow {
  n: string[];
  u: string;
}

const EPR_SUGGESTED_KEY = "epr_suggested";

const cache = new Map<string, {
  candidates: EmojiColonCandidate[];
  byUnified: Map<string, EmojiColonCandidate>;
}>();
let shortcodeByUnified: Map<string, string> | null = null;
let enNamesByUnified: Map<string, string[]> | null = null;

export function getEmojiPickerData(isZhLocale: boolean): EmojiData {
  return (isZhLocale ? emojiDataZh : emojiDataEn) as EmojiData;
}

export function unifiedToNative(unified: string): string {
  return unified
    .split("-")
    .map((part) => String.fromCodePoint(parseInt(part, 16)))
    .join("");
}

function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_+.-]/g, "");
}

/** 从 name 列表中选最长的 >= 2 字符的词组作展示名。 */
function pickLabel(names: string[]): string {
  const phrases = names.filter((name) => name.length >= 2);
  if (!phrases.length) return names[names.length - 1] ?? names[0] ?? "";
  return phrases.sort((a, b) => b.length - a.length)[0];
}

function pickEnglishShortcode(names: string[]): string {
  const slugs = names
    .map((name) => slugifyName(name))
    .filter((slug) => slug.length >= 3);
  if (!slugs.length) return "";
  return slugs.sort((a, b) => a.length - b.length)[0];
}

function buildEnglishIndices(): { shortcodes: Map<string, string>; names: Map<string, string[]> } {
  if (shortcodeByUnified && enNamesByUnified) {
    return { shortcodes: shortcodeByUnified, names: enNamesByUnified };
  }
  const sc = new Map<string, string>();
  const nm = new Map<string, string[]>();
  const enData = emojiDataEn as EmojiData;
  for (const rows of Object.values(enData.emojis)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows as EmojiPickerRow[]) {
      if (!row?.u) continue;
      nm.set(row.u, row.n);
      const shortcode = pickEnglishShortcode(row.n);
      if (shortcode) sc.set(row.u, shortcode);
    }
  }
  shortcodeByUnified = sc;
  enNamesByUnified = nm;
  return { shortcodes: sc, names: nm };
}

function buildCandidates(data: EmojiData, isZhLocale: boolean): EmojiColonCandidate[] {
  const { shortcodes, names: enNames } = buildEnglishIndices();
  const out: EmojiColonCandidate[] = [];
  const seen = new Set<string>();
  for (const rows of Object.values(data.emojis)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows as EmojiPickerRow[]) {
      if (!row?.u || !row.n?.length) continue;
      const native = unifiedToNative(row.u);
      if (!native || seen.has(row.u)) continue;
      seen.add(row.u);
      const name = pickLabel(row.n);
      const id = (
        shortcodes.get(row.u)
        ?? (isZhLocale ? "" : pickEnglishShortcode(row.n))
      ) || row.u;
      const extraKeywords = isZhLocale ? (enNames.get(row.u) ?? []) : [];
      out.push({
        id,
        name,
        native,
        unified: row.u,
        searchKeywords: [...row.n, ...extraKeywords],
      });
    }
  }
  return out;
}

function ensureCache(isZhLocale: boolean) {
  const key = isZhLocale ? "zh" : "en";
  if (cache.has(key)) return cache.get(key)!;
  const candidates = buildCandidates(getEmojiPickerData(isZhLocale), isZhLocale);
  const byUnified = new Map(candidates.map((c) => [c.unified, c]));
  const entry = { candidates, byUnified };
  cache.set(key, entry);
  return entry;
}

export function getEmojiColonCandidates(isZhLocale: boolean): EmojiColonCandidate[] {
  return ensureCache(isZhLocale).candidates;
}

/** 与 emoji-picker-react 共用 localStorage，保证 `:` 面板与 Picker 最近使用一致。 */
export function recordEmojiSuggestion(unified: string): void {
  if (typeof window === "undefined" || !unified) return;
  try {
    const raw = window.localStorage.getItem(EPR_SUGGESTED_KEY);
    const recent = (raw ? JSON.parse(raw) : []) as EprSuggestedItem[];
    let existing = recent.find((item) => item.unified === unified);
    let next: EprSuggestedItem[];
    if (existing) {
      next = [existing, ...recent.filter((item) => item !== existing)];
    } else {
      existing = { unified, original: unified, count: 0 };
      next = [existing, ...recent];
    }
    existing.count += 1;
    next.length = Math.min(next.length, 14);
    window.localStorage.setItem(EPR_SUGGESTED_KEY, JSON.stringify(next));
  } catch {
    // localStorage 可能不可用
  }
}

/** 空查询默认列表：最近使用 + 候选列表前 N 个补齐。 */
function defaultEmojiColonCandidates(
  candidates: EmojiColonCandidate[],
  isZhLocale: boolean,
  limit: number,
): EmojiColonCandidate[] {
  const recent = readRecentEmojiCandidates(isZhLocale, limit);
  if (recent.length >= limit) return recent;
  const seen = new Set(recent.map((item) => item.unified));
  const result = [...recent];
  for (const c of candidates) {
    if (result.length >= limit) break;
    if (seen.has(c.unified)) continue;
    result.push(c);
    seen.add(c.unified);
  }
  return result;
}

function readRecentEmojiCandidates(
  isZhLocale: boolean,
  limit: number,
): EmojiColonCandidate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(EPR_SUGGESTED_KEY);
    const items = (raw ? JSON.parse(raw) : []) as EprSuggestedItem[];
    const { byUnified } = ensureCache(isZhLocale);
    const picked: EmojiColonCandidate[] = [];
    for (const item of items) {
      const candidate = byUnified.get(item.unified);
      if (!candidate || picked.some((row) => row.unified === candidate.unified)) continue;
      picked.push(candidate);
      if (picked.length >= limit) break;
    }
    return picked;
  } catch {
    return [];
  }
}

export function filterEmojiColonCandidates(
  candidates: EmojiColonCandidate[],
  query: string,
  isZhLocale: boolean,
  limit = EMOJI_COLON_PALETTE_LIMIT,
): EmojiColonCandidate[] {
  const q = query.toLowerCase();
  if (!q) return defaultEmojiColonCandidates(candidates, isZhLocale, limit);
  return candidates
    .filter((emoji) => {
      const haystack = [
        emoji.id,
        emoji.unified,
        emoji.name,
        ...(emoji.searchKeywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, limit);
}
