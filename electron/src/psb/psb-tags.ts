/** PSB 回复标签解析（与 nanobot/web/psb/psb-tags.js 逻辑一致）。 */

export type PsbTagAction = {
  type: string;
  payload: Record<string, unknown>;
};

const PSB_TAG_RE = /<psb:(timeline|expression|face|fade)\b([^>]*?)\/?>/gi;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of attrText.matchAll(ATTR_RE)) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? "";
    attrs[key] = value;
  }
  return attrs;
}

function tagToAction(type: string, attrs: Record<string, string>): PsbTagAction | null {
  const normalized = type.toLowerCase();
  if (normalized === "timeline" || normalized === "expression") {
    const name = attrs.name || attrs.label || "";
    if (!name) return null;
    return { type: normalized, payload: { name } };
  }
  if (normalized === "face" || normalized === "fade") {
    const varName = attrs.var || attrs.name || "";
    const rawValue = attrs.value;
    if (!varName || rawValue === undefined || rawValue === "") return null;
    return { type: normalized, payload: { var: varName, value: rawValue } };
  }
  return null;
}

/** 从 assistant 文本解析 PSB 标签动作（按出现顺序）。 */
export function parsePsbTags(text: string): PsbTagAction[] {
  const actions: PsbTagAction[] = [];
  const source = String(text || "");
  for (const match of source.matchAll(PSB_TAG_RE)) {
    const action = tagToAction(match[1], parseAttrs(match[2]));
    if (action) actions.push(action);
  }
  return actions;
}

/** 去掉 PSB 标签，用于聊天展示。 */
export function stripPsbTags(text: string): string {
  return String(text || "")
    .replace(PSB_TAG_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 按配置决定是否隐藏 PSB 标签。 */
export function formatAssistantContentForDisplay(
  content: string,
  showResponseTags: boolean | undefined,
): string {
  if (showResponseTags) return content;
  return stripPsbTags(content);
}
