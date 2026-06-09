import { describe, expect, it } from "vitest";

import { channelBrandFor, channelLogoUrls } from "@/lib/channel-brand";
import { resolveMessageSourceBadge } from "@/lib/message-source";

const labels = { proactive: "主动推送", heartbeat: "心跳" };

describe("resolveMessageSourceBadge", () => {
  it("returns null when no source fields are present", () => {
    expect(resolveMessageSourceBadge({}, labels)).toBeNull();
  });

  it("maps external channels to channel part", () => {
    const badge = resolveMessageSourceBadge({ sourceChannel: "qq" }, labels);
    expect(badge?.parts).toEqual([
      { kind: "channel", channel: "qq", label: "QQ" },
    ]);
  });

  it("resolves wechat alias to weixin label", () => {
    const badge = resolveMessageSourceBadge({ sourceChannel: "wechat" }, labels);
    expect(badge?.parts[0]).toMatchObject({ kind: "channel", label: "WeChat" });
  });

  it("hides websocket local source", () => {
    expect(resolveMessageSourceBadge({ sourceChannel: "websocket" }, labels)).toBeNull();
  });

  it("still shows proactive when only websocket is present", () => {
    const badge = resolveMessageSourceBadge(
      { sourceChannel: "websocket", channelDelivery: true },
      labels,
    );
    expect(badge?.parts).toEqual([{ kind: "proactive", label: "主动推送" }]);
  });

  it("adds proactive segment when channelDelivery is true", () => {
    const badge = resolveMessageSourceBadge(
      { sourceChannel: "qq", channelDelivery: true },
      labels,
    );
    expect(badge?.parts).toEqual([
      { kind: "channel", channel: "qq", label: "QQ" },
      { kind: "proactive", label: "主动推送" },
    ]);
  });

  it("shows channel and proactive for user-initiated cross-channel delivery", () => {
    const badge = resolveMessageSourceBadge(
      {
        sourceChannel: "qq",
        channelDelivery: true,
        userInitiatedDelivery: true,
      },
      labels,
    );
    expect(badge?.parts).toEqual([
      { kind: "channel", channel: "qq", label: "QQ" },
      { kind: "proactive", label: "主动推送" },
    ]);
  });

  it("supports proactive-only messages", () => {
    const badge = resolveMessageSourceBadge({ channelDelivery: true }, labels);
    expect(badge?.parts).toEqual([{ kind: "proactive", label: "主动推送" }]);
  });

  it("adds cron job name instead of proactive when present", () => {
    const badge = resolveMessageSourceBadge(
      { channelDelivery: true, cronJobName: "喝水提醒" },
      labels,
    );
    expect(badge?.parts).toEqual([{ kind: "cron_job", label: "喝水提醒" }]);
  });

  it("maps heartbeat job name to i18n label without proactive prefix", () => {
    const badge = resolveMessageSourceBadge(
      { channelDelivery: true, cronJobName: "heartbeat" },
      labels,
    );
    expect(badge?.parts).toEqual([{ kind: "cron_job", label: "心跳" }]);
  });

  it("shows channel with cron job name and skips proactive", () => {
    const badge = resolveMessageSourceBadge(
      { sourceChannel: "qq", channelDelivery: true, cronJobName: "喝水提醒" },
      labels,
    );
    expect(badge?.parts).toEqual([
      { kind: "channel", channel: "qq", label: "QQ" },
      { kind: "cron_job", label: "喝水提醒" },
    ]);
  });
});

describe("channelBrandFor", () => {
  it("provides favicon urls for major IM channels", () => {
    expect(channelLogoUrls("qq").length).toBeGreaterThan(0);
    expect(channelLogoUrls("telegram").length).toBeGreaterThan(0);
    expect(channelLogoUrls("weixin").length).toBeGreaterThan(0);
    expect(channelBrandFor("wechat")?.initials).toBe("WX");
  });

  it("returns empty logo urls for unknown channels", () => {
    expect(channelLogoUrls("unknown-channel")).toEqual([]);
  });
});
