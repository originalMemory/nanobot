import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { AttachmentTile } from "@/components/AttachmentTile";

it("opens image attachments in the shared lightbox and closes them", () => {
  render(<AttachmentTile attachment={{ kind: "image", url: "/api/media/sig/photo", name: "photo.png" }} />);

  fireEvent.click(screen.getByRole("button", { name: /photo\.png/i }));
  const dialog = screen.getByRole("dialog", { name: "photo.png" });
  expect(dialog).toHaveClass("host-no-drag");
  expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute(
    "src",
    "/api/media/sig/photo",
  );

  fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
  expect(screen.queryByRole("dialog", { name: "photo.png" })).toBeNull();
});
