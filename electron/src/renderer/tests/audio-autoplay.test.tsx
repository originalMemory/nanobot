import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { MessageMedia } from "@/components/MessageBubble";

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ apiBase: "http://127.0.0.1:8765", token: "token" }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  playThaAudio: vi.fn().mockResolvedValue({ subscribers: 0 }),
}));

describe("MessageMedia 音频自动播放", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("实时到达的音频附件自动播放", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    render(
      <MessageMedia
        media={[{ kind: "audio", url: "/media/reply.mp3", name: "reply.mp3" }]}
        align="left"
        autoPlayAudio
        autoPlayAudioKey="message-1"
      />,
    );

    await waitFor(() => expect(play).toHaveBeenCalledOnce());
  });

  it("同一 URL 的不同消息分别自动播放", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const media = [{ kind: "audio" as const, url: "/media/shared.mp3" }];

    const first = render(
      <MessageMedia media={media} align="left" autoPlayAudio autoPlayAudioKey="message-a" />,
    );
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    first.unmount();
    render(
      <MessageMedia media={media} align="left" autoPlayAudio autoPlayAudioKey="message-b" />,
    );

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  });

  it("同一消息重挂载不重复自动播放", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const media = [{ kind: "audio" as const, url: "/media/remount.mp3" }];

    const first = render(
      <MessageMedia media={media} align="left" autoPlayAudio autoPlayAudioKey="same-message" />,
    );
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    first.unmount();
    render(
      <MessageMedia media={media} align="left" autoPlayAudio autoPlayAudioKey="same-message" />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(play).toHaveBeenCalledOnce();
  });

  it("自动播放失败后同一消息重挂载可重试", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue(undefined);
    const media = [{ kind: "audio" as const, url: "/media/retry.mp3" }];

    const first = render(
      <MessageMedia media={media} align="left" autoPlayAudio autoPlayAudioKey="message-retry" />,
    );
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    first.unmount();
    render(
      <MessageMedia media={media} align="left" autoPlayAudio autoPlayAudioKey="message-retry" />,
    );

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  });

  it("不展示音频文件名，并将图片与音频分成上下两行", () => {
    const { container } = render(
      <MessageMedia
        media={[
          { kind: "image", url: "/media/reply.png", name: "reply.png" },
          { kind: "audio", url: "/media/reply.mp3", name: "reply.mp3" },
        ]}
        align="left"
      />,
    );

    expect(container.textContent).not.toContain("reply.mp3");
    const mediaRoot = container.firstElementChild;
    const nonImageRow = container.querySelector('[data-testid="message-non-image-media"]');
    expect(mediaRoot?.children).toHaveLength(2);
    expect(nonImageRow?.parentElement).toBe(mediaRoot);
  });
});
