import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { ReasoningRow } from "@/components/thread/activity/ReasoningRow";

it("shows complete reasoning with its original line breaks", () => {
  const text = "First line with **Markdown**.\nSecond line with details.";
  render(<ReasoningRow text={text} streaming={false} />);

  const line = screen.getByTestId("activity-line");
  expect(line.textContent).toBe(text);
  expect(line).toHaveClass("whitespace-pre-wrap");
  expect(line.querySelector(".truncate")).toBeNull();
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("keeps long streaming reasoning intact without animated duplicate text", () => {
  const text = "A long reasoning paragraph. ".repeat(2_000) + "🚀 final line";
  const { container } = render(<ReasoningRow text={text} streaming />);

  expect(screen.getByTestId("activity-line").textContent).toBe(text);
  expect(screen.getByTestId("activity-reasoning-marker")).toHaveAttribute("data-state", "thinking");
  expect(container.querySelector("[data-sheen-text]")).toBeNull();
});
