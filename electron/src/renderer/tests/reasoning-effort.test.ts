import { describe, expect, it } from "vitest";

import { normalizeReasoningEffort } from "@/lib/reasoning-effort";

describe("reasoning-effort helpers", () => {
  it("normalizes known values and falls back to default", () => {
    expect(normalizeReasoningEffort(null)).toBe("");
    expect(normalizeReasoningEffort("HIGH")).toBe("high");
    expect(normalizeReasoningEffort("unknown")).toBe("");
  });

});
