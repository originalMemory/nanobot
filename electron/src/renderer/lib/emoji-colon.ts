export interface EmojiColonCandidate {
  id: string;
  name: string;
  native: string;
  unified: string;
  searchKeywords?: string[];
}

export interface EmojiColonQuery {
  query: string;
  start: number;
  end: number;
}

export const EMOJI_COLON_PALETTE_LIMIT = 8;

/** 光标前 ``:shortcode`` / ``：关键词``（半角/全角冒号，需前有行首或空白）。 */
export function parseEmojiColonQuery(
  value: string,
  caret: number,
): EmojiColonQuery | null {
  const safeCaret = Math.min(Math.max(caret, 0), value.length);
  const beforeCaret = value.slice(0, safeCaret);
  const match = /(?:^|\s)[:：]([a-z0-9_+.\-\u4e00-\u9fff]*)$/iu.exec(beforeCaret);
  if (!match) return null;
  const query = (match[1] ?? "").toLowerCase();
  const colonIndex = match.index! + match[0].length - query.length - 1;
  return {
    query,
    start: colonIndex,
    end: safeCaret,
  };
}
