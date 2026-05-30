import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { MessageBubble } from "@/components/MessageBubble";
import {
  AssistantTurnBubble,
  type TurnSegment,
} from "@/components/thread/AssistantTurnBubble";
import {
  isAgentActivityMember,
  isReasoningOnlyAssistant,
} from "@/components/thread/AgentActivityCluster";
import type { CliAppInfo, McpPresetInfo, UIMessage } from "@/lib/types";

interface ThreadMessagesProps {
  messages: UIMessage[];
  /** When true, agent turn still in flight — keeps activity cluster expanded. */
  isStreaming?: boolean;
  hiddenMessageCount?: number;
  onLoadEarlier?: () => void;
  cliApps?: CliAppInfo[];
  mcpPresets?: McpPresetInfo[];
}

type RawDisplayUnit =
  | { type: "cluster"; messages: UIMessage[] }
  | { type: "single"; message: UIMessage };

export type DisplayUnit =
  | { type: "single"; message: UIMessage }
  | { type: "assistant-turn"; segments: TurnSegment[]; isStreaming: boolean };

export function buildDisplayUnits(messages: UIMessage[]): RawDisplayUnit[] {
  const out: RawDisplayUnit[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (isAgentActivityMember(m)) {
      const cluster: UIMessage[] = [];
      let segmentId: string | undefined = m.activitySegmentId;
      let clusterHasFileEdits = hasFileEdits(m);
      while (
        i < messages.length
        && isAgentActivityMember(messages[i])
        && canJoinActivityCluster(segmentId, clusterHasFileEdits, messages[i])
      ) {
        const current = messages[i];
        if (!segmentId && current.activitySegmentId) {
          segmentId = current.activitySegmentId;
        }
        clusterHasFileEdits = clusterHasFileEdits || hasFileEdits(current);
        cluster.push(current);
        i += 1;
      }
      out.push({ type: "cluster", messages: cluster });
      continue;
    }
    const previous = out[out.length - 1];
    if (
      previous?.type === "cluster"
      && assistantHasInlineReasoning(m)
      && canFoldInlineReasoning(previous.messages, m)
    ) {
      foldInlineReasoningIntoCluster(previous.messages, m);
      out.push({ type: "single", message: stripInlineReasoning(m) });
      i += 1;
      continue;
    }
    if (assistantHasInlineReasoning(m)) {
      out.push({ type: "cluster", messages: [reasoningOnlyMessageFromAnswer(m)] });
      out.push({ type: "single", message: stripInlineReasoning(m) });
      i += 1;
      continue;
    }
    out.push({ type: "single", message: m });
    i += 1;
  }
  return out;
}

/** 将同一 user turn 内的 cluster / assistant 正文收成单个 SAP 气泡，保留时序交错。 */
export function coalesceAssistantTurnUnits(
  rawUnits: RawDisplayUnit[],
  globalStreaming: boolean,
): DisplayUnit[] {
  const out: DisplayUnit[] = [];
  let i = 0;
  while (i < rawUnits.length) {
    const unit = rawUnits[i];
    if (!isAssistantTurnRawUnit(unit)) {
      if (unit.type === "single") {
        out.push(unit);
      }
      i += 1;
      continue;
    }
    const segments: TurnSegment[] = [];
    while (i < rawUnits.length && isAssistantTurnRawUnit(rawUnits[i])) {
      const current = rawUnits[i];
      if (current.type === "cluster") {
        segments.push({
          kind: "activity",
          messages: current.messages,
          turnLatencyMs: activitySegmentTurnLatency(current.messages),
        });
      } else {
        segments.push({ kind: "text", message: current.message });
      }
      i += 1;
    }
    out.push({ type: "assistant-turn", segments: enrichActivitySegmentLatencies(segments), isStreaming: false });
  }

  if (!globalStreaming) {
    return out;
  }
  for (let j = out.length - 1; j >= 0; j -= 1) {
    const unit = out[j];
    if (unit.type === "assistant-turn") {
      out[j] = {
        type: "assistant-turn",
        segments: unit.segments,
        isStreaming: true,
      };
      break;
    }
  }
  return out;
}

/** 为 activity 段推算耗时：从本段首条消息到下一段开始的时间差。 */
function enrichActivitySegmentLatencies(segments: TurnSegment[]): TurnSegment[] {
  return segments.map((segment, index) => {
    if (segment.kind !== "activity" || segment.turnLatencyMs != null) {
      return segment;
    }
    const starts = segment.messages
      .map((message) => message.createdAt)
      .filter((value) => Number.isFinite(value));
    if (!starts.length) {
      return segment;
    }
    const start = Math.min(...starts);
    let end: number | undefined;
    for (let j = index + 1; j < segments.length; j += 1) {
      const next = segments[j];
      if (next.kind === "text") {
        end = next.message.createdAt;
      } else {
        const nextStarts = next.messages
          .map((message) => message.createdAt)
          .filter((value) => Number.isFinite(value));
        if (nextStarts.length) {
          end = Math.min(...nextStarts);
        }
      }
      if (Number.isFinite(end)) {
        break;
      }
    }
    if (end == null || end < start) {
      return segment;
    }
    return { ...segment, turnLatencyMs: end - start };
  });
}

function isAssistantTurnRawUnit(unit: RawDisplayUnit): boolean {
  return unit.type === "cluster"
    || (unit.type === "single" && unit.message.role === "assistant");
}

function assistantHasInlineReasoning(message: UIMessage): boolean {
  return (
    message.role === "assistant"
    && message.kind !== "trace"
    && message.content.trim().length > 0
    && (!!message.reasoning?.trim() || !!message.reasoningStreaming)
  );
}

function reasoningOnlyMessageFromAnswer(message: UIMessage): UIMessage {
  return {
    id: `${message.id}-reasoning`,
    role: "assistant",
    content: "",
    createdAt: message.createdAt,
    reasoning: message.reasoning,
    reasoningStreaming: message.reasoningStreaming,
    isStreaming: message.reasoningStreaming,
    activitySegmentId: message.activitySegmentId,
    latencyMs: message.latencyMs,
  };
}

function stripInlineReasoning(message: UIMessage): UIMessage {
  const next = { ...message };
  delete next.reasoning;
  delete next.reasoningStreaming;
  return next;
}

/**
 * 将 answer 消息上的 reasoning 折进前置 activity cluster。
 *
 * 背景：session replay 时 transcript.absorbComplete 会把「工具调用之前」的
 * reasoning-only 行复制到最终 answer 上，并 prune 掉原 placeholder。此时 UIMessage
 * 顺序变成 [trace, trace, …, answer+reasoning]，若直接 push 到 cluster 末尾，
 * 折叠块里就会出现「工具在上、思考过程在下」的倒序。
 *
 * 不按 createdAt 做全序插入：折回 cluster 时时间戳常常缺失或不可信，且 trace 顺序
 * 已由 UIMessage 数组保证。实际只有两种常见形态，用两条规则即可：
 *
 * 1. cluster 里尚无任何 reasoning 行 → 这是从早期 placeholder 迁来的「第一轮思考」，
 *    应 splice 到首个 trace 之前（思考 → 工具）。
 * 2. cluster 开头已有 reasoning 行 → answer 上的是工具后的「第二轮思考」，接在末尾
 *    （思考 → 工具 → 再思考）。若文本与已有行相同则跳过，避免重复。
 */
function foldInlineReasoningIntoCluster(cluster: UIMessage[], message: UIMessage): void {
  const reasoningRow = reasoningOnlyMessageFromAnswer(message);
  const reasoningText = reasoningRow.reasoning?.trim();
  if (
    reasoningText
    && cluster.some(
      (row) => isReasoningOnlyAssistant(row) && row.reasoning?.trim() === reasoningText,
    )
  ) {
    return;
  }
  const hasLeadingReasoning = cluster.some((row) => isReasoningOnlyAssistant(row));
  const firstTraceIdx = cluster.findIndex((row) => row.kind === "trace");
  if (!hasLeadingReasoning && firstTraceIdx !== -1) {
    cluster.splice(firstTraceIdx, 0, reasoningRow);
    return;
  }
  cluster.push(reasoningRow);
}

function canFoldInlineReasoning(cluster: UIMessage[], message: UIMessage): boolean {
  if (!clusterHasFileEdits(cluster) && !hasFileEdits(message)) return true;
  const segmentId = clusterSegmentId(cluster);
  if (!segmentId || !message.activitySegmentId) return true;
  return segmentId === message.activitySegmentId;
}

function clusterSegmentId(messages: UIMessage[]): string | undefined {
  return messages.find((message) => message.activitySegmentId)?.activitySegmentId;
}

function hasFileEdits(message: UIMessage): boolean {
  return !!message.fileEdits?.length;
}

function clusterHasFileEdits(messages: UIMessage[]): boolean {
  return messages.some(hasFileEdits);
}

function canJoinActivityCluster(
  clusterSegmentId: string | undefined,
  clusterIncludesFileEdits: boolean,
  message: UIMessage,
): boolean {
  const messageHasFileEdits = hasFileEdits(message);
  if (!clusterIncludesFileEdits && !messageHasFileEdits) return true;
  if (!clusterSegmentId || !message.activitySegmentId) return true;
  return clusterSegmentId === message.activitySegmentId;
}

/** 仅使用 activity 行自身携带的 latency，避免把整轮耗时误打到中间段。 */
function activitySegmentTurnLatency(messages: UIMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const latency = messages[i].latencyMs;
    if (typeof latency === "number" && Number.isFinite(latency) && latency >= 0) {
      return latency;
    }
  }
  return undefined;
}

export function assistantCopyFlags(units: DisplayUnit[]): boolean[] {
  const flags = new Array<boolean>(units.length).fill(true);
  let hasLaterUnitBeforeUser = false;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit.type === "single" && unit.message.role === "user") {
      hasLaterUnitBeforeUser = false;
      continue;
    }
    if (unit.type === "assistant-turn") {
      flags[i] = !hasLaterUnitBeforeUser;
    }
    hasLaterUnitBeforeUser = true;
  }
  return flags;
}

export function buildFinalDisplayUnits(
  messages: UIMessage[],
  globalStreaming: boolean,
): DisplayUnit[] {
  return coalesceAssistantTurnUnits(buildDisplayUnits(messages), globalStreaming);
}

export function ThreadMessages({
  messages,
  isStreaming = false,
  hiddenMessageCount = 0,
  onLoadEarlier,
  cliApps = [],
  mcpPresets = [],
}: ThreadMessagesProps) {
  const { t } = useTranslation();
  const units = useMemo(
    () => buildFinalDisplayUnits(messages, isStreaming),
    [messages, isStreaming],
  );
  const copyFlags = useMemo(() => assistantCopyFlags(units), [units]);

  return (
    <div className="flex w-full flex-col">
      {hiddenMessageCount > 0 && onLoadEarlier ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={onLoadEarlier}
            className="rounded-full border border-border/60 bg-background/85 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted/55 hover:text-foreground"
          >
            {t("thread.loadEarlier", {
              count: hiddenMessageCount,
              defaultValue: "Load earlier messages",
            })}
          </button>
        </div>
      ) : null}
      {units.map((unit, index) => (
        <div key={unitKey(unit, index)} className={index > 0 ? "mt-5" : ""}>
          {unit.type === "assistant-turn" ? (
            <AssistantTurnBubble
              segments={unit.segments}
              isTurnStreaming={unit.isStreaming}
              showCopyAction={copyFlags[index]}
              cliApps={cliApps}
              mcpPresets={mcpPresets}
            />
          ) : (
            <MessageBubble
              message={unit.message}
              showAssistantCopyAction={
                unit.message.role === "assistant"
                  ? copyFlags[index]
                  : true
              }
              cliApps={cliApps}
              mcpPresets={mcpPresets}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function unitKey(unit: DisplayUnit, index: number): string {
  if (unit.type === "assistant-turn") {
    const anchor = unit.segments[0]?.kind === "text"
      ? unit.segments[0].message.id
      : unit.segments[0]?.kind === "activity"
        ? unit.segments[0].messages[0]?.id
        : undefined;
    return anchor != null ? `turn-${anchor}` : `turn-idx-${index}`;
  }
  return unit.message.id;
}
