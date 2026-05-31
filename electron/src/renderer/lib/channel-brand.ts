import { faviconUrls } from "@/lib/provider-brand";
import { normalizeChannel } from "@/lib/channels";

export interface ChannelBrand {
  logoUrls: string[];
  color: string;
  initials: string;
}

function channelBrand(domain: string, color: string, initials: string): ChannelBrand {
  return { logoUrls: faviconUrls(domain), color, initials };
}

/** 主要 IM 通道 favicon + 品牌色。 */
const CHANNEL_BRANDS: Record<string, ChannelBrand> = {
  telegram: channelBrand("telegram.org", "#26A5E4", "TG"),
  qq: channelBrand("q.qq.com", "#12B7F5", "QQ"),
  weixin: channelBrand("weixin.qq.com", "#07C160", "WX"),
  discord: channelBrand("discord.com", "#5865F2", "DC"),
  slack: channelBrand("slack.com", "#E01E5A", "SL"),
  feishu: channelBrand("feishu.cn", "#3370FF", "FS"),
  dingtalk: channelBrand("dingtalk.com", "#0089FF", "DT"),
  wecom: channelBrand("work.weixin.qq.com", "#267EF0", "WC"),
  whatsapp: channelBrand("whatsapp.com", "#25D366", "WA"),
  line: channelBrand("line.me", "#06C755", "LN"),
  email: channelBrand("gmail.com", "#EA4335", "EM"),
  matrix: channelBrand("matrix.org", "#0DBD8B", "MX"),
  msteams: channelBrand("teams.microsoft.com", "#6264A7", "TM"),
  signal: channelBrand("signal.org", "#3A76F0", "SG"),
};

export function channelBrandFor(channel: string): ChannelBrand | null {
  return CHANNEL_BRANDS[normalizeChannel(channel)] ?? null;
}

/** 获取通道 favicon 列表；未知通道返回空数组（由 UI 回退 MessageCircle）。 */
export function channelLogoUrls(channel: string): string[] {
  return channelBrandFor(channel)?.logoUrls ?? [];
}

/** 通道 label 着色；未知通道用 muted 默认色。 */
export function channelAccentColor(channel: string): string | undefined {
  return channelBrandFor(channel)?.color;
}
