import type { TurnUsageStats } from "@/lib/types";

/** ↑ display: prompt tokens accumulated across every LLM call in this turn. */
export function displayPromptIn(usage: TurnUsageStats): number {
  if (usage.turn_prompt_tokens != null && usage.turn_prompt_tokens > 0) {
    return usage.turn_prompt_tokens;
  }
  return usage.prompt_tokens ?? usage.last_prompt_tokens ?? 0;
}

/** Turn-total prompt tokens (billing); shown in tooltip when split fields exist. */
export function turnTotalPromptIn(usage: TurnUsageStats): number | undefined {
  if (usage.turn_prompt_tokens != null && usage.turn_prompt_tokens > 0) {
    return usage.turn_prompt_tokens;
  }
  if (usage.last_prompt_tokens != null) {
    return undefined;
  }
  return usage.prompt_tokens;
}

/** ↓ display: completion tokens for the whole turn. */
export function displayCompletionOut(usage: TurnUsageStats): number {
  return usage.turn_completion_tokens ?? usage.completion_tokens ?? 0;
}

/** R display: cache reads accumulated across every LLM call in this turn. */
export function displayCacheRead(usage: TurnUsageStats): number {
  if (usage.turn_cached_tokens != null && usage.turn_cached_tokens > 0) {
    return usage.turn_cached_tokens;
  }
  return usage.cached_tokens ?? usage.last_cached_tokens ?? 0;
}

export function buildTokenUsageTitle(
  usage: TurnUsageStats,
  t: (key: string, opts?: { defaultValue?: string }) => string,
): string {
  const lines: string[] = [];
  const turnIn = displayPromptIn(usage);
  if (turnIn > 0) {
    lines.push(
      t("message.tokenUsageTurnTotalIn", {
        defaultValue: "Turn total input (all LLM calls)",
      }) + `: ${turnIn.toLocaleString()}`,
    );
  }
  const turnOut = displayCompletionOut(usage);
  if (turnOut > 0) {
    lines.push(
      t("message.tokenUsageTurnTotalOut", {
        defaultValue: "Turn total output",
      }) + `: ${turnOut.toLocaleString()}`,
    );
  }
  const turnCacheRead = displayCacheRead(usage);
  if (turnCacheRead > 0) {
    lines.push(
      t("message.tokenUsageTurnCacheRead", {
        defaultValue: "Turn cache read",
      }) + `: ${turnCacheRead.toLocaleString()}`,
    );
  }
  if (
    usage.last_prompt_tokens != null
    && usage.last_prompt_tokens > 0
    && usage.last_prompt_tokens !== turnIn
  ) {
    lines.push(
      t("message.tokenUsageLastCallIn", {
        defaultValue: "Last LLM call input",
      }) + `: ${usage.last_prompt_tokens.toLocaleString()}`,
    );
  }
  const ctxTok = usage.context_tokens;
  if (ctxTok != null && ctxTok > 0) {
    lines.push(
      t("message.tokenUsageContextSize", {
        defaultValue: "Context at this message (estimated prompt for replay)",
      }) + `: ${ctxTok.toLocaleString()}`,
    );
  }
  if (lines.length === 0) {
    return t("message.tokenUsageTitle", {
      defaultValue: "↑ context at cutoff · ↓ turn output · R cache read · ctx% window used",
    });
  }
  return lines.join("\n");
}
