import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceMarkdown } from "@/components/workspace/WorkspaceMarkdown";


describe("WorkspaceMarkdown diary rendering", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders frontmatter, banner, image embeds, and multi-column callouts", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const resolveImage = vi.fn(async (name: string) => (
      name.endsWith(".jpg") ? "data:image/jpeg;base64,aGVsbG8=" : null
    ));
    const { container } = render(
      <WorkspaceMarkdown
        path="2026/08/2026-08-19 周三.md"
        diary
        frontmatter={{
          概要: "今天的摘要",
          心情: ["平淡", "开心"],
          banner: "[[20260819_banner.jpg]]",
          banner_y: 34,
        }}
        resolveImage={resolveImage}
      >
        {`> [!multi-column]\n>\n>> [!info] 详情\n>>\n>> 正文\n>\n>> [!info] 月相\n>>\n>> ![[2026_moon.5529.jpg|800x600]]`}
      </WorkspaceMarkdown>,
    );

    expect(screen.getByText("今天的摘要")).toBeInTheDocument();
    expect(container.querySelector('[data-callout="multi-column"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-callout="info"]')).toHaveLength(2);

    await waitFor(() => {
      const image = screen.getByAltText("2026_moon.5529.jpg");
      expect(image).toHaveAttribute("width", "800");
      expect(image).toHaveAttribute("height", "600");
      expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,aGVsbG8=");
    });
    expect(container.querySelector("article > div img")?.getAttribute("src")).toBe(
      "data:image/jpeg;base64,aGVsbG8=",
    );
    expect(container.querySelector("article > div img")).toHaveStyle({
      objectPosition: "50% 34%",
    });
  });

  it("defers inline image loading until the placeholder approaches the viewport", async () => {
    let onIntersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    class FakeIntersectionObserver {
      constructor(callback: typeof onIntersect) { onIntersect = callback; }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const resolveImage = vi.fn(async () => "data:image/jpeg;base64,aGVsbG8=");
    render(
      <WorkspaceMarkdown
        path="2026/08/2026-08-19 周三.md"
        diary
        resolveImage={resolveImage}
      >
        ![[large-photo.jpg]]
      </WorkspaceMarkdown>,
    );
    expect(resolveImage).not.toHaveBeenCalled();

    act(() => onIntersect?.([{ isIntersecting: true }]));

    await waitFor(() => expect(resolveImage).toHaveBeenCalledWith("large-photo.jpg"));
    expect(await screen.findByAltText("large-photo.jpg")).toBeInTheDocument();
  });
});
