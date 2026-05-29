/**
 * Channel display metadata shared between InboxSidebar and InboxView.
 */

export const CHANNEL_LABEL: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  wechat: "WeChat",
  line: "LINE",
  whatsapp: "WhatsApp",
  email: "Email",
  websocket: "WebSocket",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel.toLowerCase()] ?? channel;
}

export function channelInitial(channel: string): string {
  const label = channelLabel(channel);
  // Use Array.from to split by Unicode code points rather than UTF-16 code units,
  // so emoji-starting labels don't produce broken surrogate pairs.
  return Array.from(label).slice(0, 2).join("").toUpperCase();
}
