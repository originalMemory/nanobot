import { describe, expect, it } from "vitest";

import {
  displayCacheRead,
  displayCompletionOut,
  displayPromptIn,
  turnTotalPromptIn,
} from "@/lib/turn-usage";
import type { TurnUsageStats } from "@/lib/types";

describe("turn usage display helpers", () => {
  it("uses turn totals for the compact footer when split fields exist", () => {
    const usage: TurnUsageStats = {
      last_prompt_tokens: 11000,
      turn_prompt_tokens: 152835,
      turn_completion_tokens: 1366,
      last_cached_tokens: 9000,
      turn_cached_tokens: 140000,
    };
    expect(displayPromptIn(usage)).toBe(152835);
    expect(turnTotalPromptIn(usage)).toBe(152835);
    expect(displayCompletionOut(usage)).toBe(1366);
    expect(displayCacheRead(usage)).toBe(140000);
  });

  it("falls back to legacy prompt_tokens when no split fields", () => {
    const usage: TurnUsageStats = {
      prompt_tokens: 152835,
      completion_tokens: 1366,
    };
    expect(displayPromptIn(usage)).toBe(152835);
    expect(turnTotalPromptIn(usage)).toBe(152835);
  });

  it("falls back to last-call fields when turn totals are unavailable", () => {
    const usage: TurnUsageStats = {
      last_prompt_tokens: 11000,
      last_cached_tokens: 9000,
    };
    expect(displayPromptIn(usage)).toBe(11000);
    expect(displayCacheRead(usage)).toBe(9000);
  });
});
