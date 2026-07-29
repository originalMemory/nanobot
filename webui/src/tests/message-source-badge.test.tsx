import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageSourceBadge } from "@/components/MessageSourceBadge";
import i18n from "@/i18n";

describe("MessageSourceBadge", () => {
  it("uses the localized heartbeat label without an icon", async () => {
    await i18n.changeLanguage("zh-CN");
    const { container } = render(
      <MessageSourceBadge
        message={{
          id: "heartbeat",
          role: "assistant",
          content: "heartbeat result",
          channelDelivery: true,
          cronJobName: "heartbeat",
          createdAt: 1,
        }}
      />,
    );

    expect(screen.getByText("心跳")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.getByText("心跳").closest("span.inline-flex")).toHaveClass(
      "border-violet-500/40",
      "bg-violet-500/15",
      "text-violet-700",
    );
  });

  it("restores the amber proactive badge with a bell icon", async () => {
    await i18n.changeLanguage("zh-CN");
    const { container } = render(
      <MessageSourceBadge
        message={{
          id: "proactive",
          role: "assistant",
          content: "proactive result",
          channelDelivery: true,
          createdAt: 1,
        }}
      />,
    );

    const label = screen.getByText("主动推送");
    expect(label.closest("span.inline-flex")).toHaveClass(
      "border-amber-500/30",
      "bg-amber-500/15",
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
