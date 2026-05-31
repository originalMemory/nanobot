/**
 * Channel display metadata shared between InboxSidebar and InboxView.
 */

export const CHANNEL_ALIASES: Record<string, string> = {
  wechat: "weixin",
};

export const CHANNEL_LABEL: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  weixin: "WeChat",
  qq: "QQ",
  feishu: "Feishu",
  dingtalk: "DingTalk",
  wecom: "WeCom",
  line: "LINE",
  whatsapp: "WhatsApp",
  email: "Email",
  websocket: "WebSocket",
  matrix: "Matrix",
  msteams: "Microsoft Teams",
  signal: "Signal",
  mochat: "Mochat",
};

export function normalizeChannel(channel: string): string {
  const key = channel.toLowerCase();
  return CHANNEL_ALIASES[key] ?? key;
}

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[normalizeChannel(channel)] ?? channel;
}

export function channelInitial(channel: string): string {
  const label = channelLabel(channel);
  // Use Array.from to split by Unicode code points rather than UTF-16 code units,
  // so emoji-starting labels don't produce broken surrogate pairs.
  return Array.from(label).slice(0, 2).join("").toUpperCase();
}

/** Electron 本机（websocket）来源不在 UI 展示。 */
export function isHiddenLocalSourceChannel(channel: string | undefined): boolean {
  return normalizeChannel(channel?.trim() ?? "") === "websocket";
}
