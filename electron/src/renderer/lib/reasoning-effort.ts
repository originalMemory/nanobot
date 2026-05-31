/** 思考模式可选值；空字符串表示 provider / preset 默认。 */
export const REASONING_EFFORT_VALUES = [
  "",
  "none",
  "low",
  "medium",
  "high",
  "adaptive",
] as const;

export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number];

export function normalizeReasoningEffort(
  value: string | null | undefined,
): ReasoningEffortValue {
  if (!value) return "";
  const lower = value.trim().toLowerCase();
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(lower)
    ? (lower as ReasoningEffortValue)
    : "";
}

export function reasoningEffortLabelKey(value: ReasoningEffortValue): string {
  return value || "default";
}
