import { describe, expect, it } from "vitest";

import { RENDER_SESSION_START, inferMediaKind, isLiveArrival, toMediaAttachment } from "@/lib/media";

describe("isLiveArrival", () => {
  it("仅将渲染会话启动后的消息视为直播消息", () => {
    expect(isLiveArrival(RENDER_SESSION_START)).toBe(false);
    expect(isLiveArrival(RENDER_SESSION_START + 1)).toBe(true);
  });
});

describe("inferMediaKind — 图片", () => {
  it.each([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])(
    "扩展名 %s → image",
    (ext) => {
      expect(inferMediaKind({ name: `file${ext}` })).toBe("image");
    },
  );

  it("data:image/ URL → image", () => {
    expect(inferMediaKind({ url: "data:image/png;base64,abc" })).toBe("image");
  });
});

describe("inferMediaKind — 视频", () => {
  it.each([".mp4", ".webm", ".mov", ".m4v"])(
    "扩展名 %s → video",
    (ext) => {
      expect(inferMediaKind({ name: `file${ext}` })).toBe("video");
    },
  );

  it("data:video/ URL → video", () => {
    expect(inferMediaKind({ url: "data:video/mp4;base64,abc" })).toBe("video");
  });
});

describe("inferMediaKind — 音频", () => {
  it.each([".mp3", ".wav", ".ogg", ".aac", ".m4a", ".weba", ".flac", ".opus"])(
    "扩展名 %s → audio",
    (ext) => {
      expect(inferMediaKind({ name: `file${ext}` })).toBe("audio");
    },
  );

  it("data:audio/ URL → audio", () => {
    expect(inferMediaKind({ url: "data:audio/mpeg;base64,abc" })).toBe("audio");
  });

  it("URL 路径中含音频扩展名 → audio", () => {
    expect(inferMediaKind({ url: "/media/websocket/tts/greeting.mp3?token=x" })).toBe("audio");
  });

  it("name 优先于 URL 扩展名", () => {
    // name 为 .mp3，URL 扩展名为 .bin
    expect(inferMediaKind({ url: "/media/abc.bin", name: "voice.mp3" })).toBe("audio");
  });
});

describe("inferMediaKind — 未知文件", () => {
  it("无法识别 → file", () => {
    expect(inferMediaKind({ name: "report.pdf" })).toBe("file");
  });

  it("空输入 → file", () => {
    expect(inferMediaKind({})).toBe("file");
  });
});

describe("toMediaAttachment — 音频", () => {
  it("正确推断 kind=audio", () => {
    const att = toMediaAttachment({ url: "/media/tts/hello.mp3", name: "hello.mp3" });
    expect(att.kind).toBe("audio");
    expect(att.url).toBe("/media/tts/hello.mp3");
    expect(att.name).toBe("hello.mp3");
  });

  it("显式传入 kind 优先", () => {
    const att = toMediaAttachment({ url: "/file.mp3", kind: "file" });
    expect(att.kind).toBe("file");
  });
});
