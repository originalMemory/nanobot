import { describe, expect, it } from "vitest";

import {
  displayCompletionOut,
  displayPromptIn,
  turnTotalPromptIn,
} from "@/lib/turn-usage";
import type { TurnUsageStats } from "@/lib/types";

describe("turn usage display helpers", () => {
  it("uses last_prompt_tokens for ↑ when split fields exist", () => {
    const usage: TurnUsageStats = {
      last_prompt_tokens: 11000,
      turn_prompt_tokens: 152835,
      turn_completion_tokens: 1366,
    };
    expect(displayPromptIn(usage)).toBe(11000);
    expect(turnTotalPromptIn(usage)).toBe(152835);
    expect(displayCompletionOut(usage)).toBe(1366);
  });

  it("falls back to legacy prompt_tokens when no split fields", () => {
    const usage: TurnUsageStats = {
      prompt_tokens: 152835,
      completion_tokens: 1366,
    };
    expect(displayPromptIn(usage)).toBe(152835);
    expect(turnTotalPromptIn(usage)).toBe(152835);
  });
});
