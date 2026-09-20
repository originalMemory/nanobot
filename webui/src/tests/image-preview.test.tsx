import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { useState } from "react";

import { AttachmentTile } from "@/components/AttachmentTile";
import { MediaLightbox } from "@/components/ImageLightbox";

it("opens image attachments in the shared lightbox and closes them", () => {
  render(<AttachmentTile attachment={{ kind: "image", url: "/api/media/sig/photo", name: "photo.png" }} />);

  fireEvent.click(screen.getByRole("button", { name: /photo\.png/i }));
  const dialog = screen.getByRole("dialog", { name: "photo.png" });
  expect(dialog).toHaveClass("host-no-drag");
  expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute(
    "src",
    "/api/media/sig/photo",
  );

  fireEvent.click(screen.getByRole("button", { name: "Close media preview" }));
  expect(screen.queryByRole("dialog", { name: "photo.png" })).toBeNull();
});

it("switches between images and videos with buttons and the keyboard", () => {
  function Gallery() {
    const [index, setIndex] = useState(0);
    return <MediaLightbox
      items={[
        { kind: "image", url: "/api/media/sig/photo", name: "photo.png" },
        { kind: "video", url: "/api/media/sig/movie", name: "movie.mp4" },
      ]}
      index={index}
      onIndexChange={setIndex}
      onOpenChange={() => {}}
    />;
  }
  render(<Gallery />);

  fireEvent.keyDown(window, { key: "ArrowRight" });
  let dialog = screen.getByRole("dialog", { name: "movie.mp4" });
  expect(dialog.querySelector("video[controls]")).toHaveAttribute(
    "src",
    "/api/media/sig/movie",
  );
  const video = dialog.querySelector("video")!;
  fireEvent.keyDown(video, { key: "ArrowLeft" });
  expect(screen.getByRole("dialog", { name: "movie.mp4" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Previous media" }));
  expect(screen.getByRole("dialog", { name: "photo.png" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next media" }));
  dialog = screen.getByRole("dialog", { name: "movie.mp4" });
  expect(dialog.querySelector("video[controls]")).toBeInTheDocument();
});
