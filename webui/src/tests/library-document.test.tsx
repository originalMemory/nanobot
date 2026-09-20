import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { LibraryDocument } from "@/components/library/LibraryDocument";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";

it("restores the lover banner, title, properties and native WebP document images", async () => {
  const view = render(<LibraryDocument path="日记/2026/09/我的日记.md"
    properties={{ banner: "[[cover.webp]]", banner_y: 0.3, tags: ["生活", "旅行"], empty: "" }}
    localImages={{ "cover.webp": "/api/media/test/cover", "photo.jpg": "/api/media/test/photo" }} onOpenFilePreview={() => {}}>
    {"> [!summary] 今天\n> 很开心\n\n![[photo.jpg|320x200]]\n\n`![[code.webp]]`\n\n```md\n> [!quote] example\n![[code.webp]]\n```"}
  </LibraryDocument>);
  expect(screen.getByText("我的日记")).toBeInTheDocument();
  expect(screen.getByText("生活")).toHaveClass("rounded-full");
  expect(view.container.querySelector('img[alt=""]')).toHaveStyle({ objectPosition: "50% 30%" });
  const photo = await screen.findByRole("img", { name: "photo.jpg" });
  expect(photo).toHaveAttribute("src", "/api/media/test/photo");
  expect(photo).toHaveAttribute("width", "320");
  expect(photo).toHaveAttribute("height", "200");
  expect(view.container.querySelector('[data-callout="summary"] .callout-title')?.textContent).toBe("今天");
  expect(view.container.querySelector('[data-callout="summary"] > p')).toHaveTextContent("很开心");
  expect(view.container.querySelectorAll(".obsidian-callout")).toHaveLength(1);
  expect(view.container.querySelectorAll("img")).toHaveLength(2);
});

it("keeps nested callout columns and suppresses only the real timeline placeholder", () => {
  const view = render(<MarkdownTextRenderer document localImages={{}}>{
    '> [!multi-column]\n>\n>> [!quote] 左\n>> 内容\n>\n>> [!summary] 右\n>> 摘要\n\n<div class="timeline-container"></div>\n\n`<div class="timeline-container"></div>`'
  }</MarkdownTextRenderer>);
  expect(view.container.querySelectorAll('[data-callout="multi-column"] > .obsidian-callout')).toHaveLength(2);
  expect(screen.getByText('<div class="timeline-container"></div>')).toBeInTheDocument();
});

it("renders the Obsidian day-of-year timeline without loading vault CSS", () => {
  const { container } = render(<MarkdownTextRenderer document localImages={{}}>{
    '<div class="timeline-container" data-dv-key="timeline274"></div>'
  }</MarkdownTextRenderer>);

  const timeline = screen.getByRole("img", { name: "Day 274 of 365" });
  expect(timeline).toHaveAttribute("data-testid", "diary-timeline");
  expect(timeline).toHaveTextContent("1月");
  expect(timeline).toHaveTextContent("12月");
  expect(container.querySelector('[data-diary-timeline-day="274"]')).toBeNull();
  expect(timeline.querySelector<HTMLElement>('.bg-red-500')).toHaveStyle({
    left: `${((274 - 0.5) / 365) * 100}%`,
  });
});

it("does not interpret callouts in ordinary chat or render unsafe banner protocols", () => {
  const view = render(<LibraryDocument path="note.md" properties={{ banner: "javascript:alert(1)" }} onOpenFilePreview={() => {}}>text</LibraryDocument>);
  expect(view.container.querySelector("img")).toBeNull();
  view.rerender(<MarkdownTextRenderer>{"> [!summary] 普通聊天"}</MarkdownTextRenderer>);
  expect(view.container.querySelector(".obsidian-callout")).toBeNull();
});

it.each(["[!multi-column]", "[!summary] **标题**"])("无空行时将 %s 的正文留在标题之外", (marker) => {
  const { container } = render(<MarkdownTextRenderer document localImages={{}}>{`> ${marker}\n> 正文第一行\n> 正文第二行`}</MarkdownTextRenderer>);
  const title = container.querySelector(".callout-title");
  expect(title?.textContent).toBe(marker.includes("summary") ? "标题" : "multi-column");
  expect(container.querySelector(".obsidian-callout > p")).toHaveTextContent("正文第一行 正文第二行");
  expect(title?.textContent).not.toContain("正文");
});
