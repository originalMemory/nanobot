import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { MessageBubble } from "@/components/MessageBubble";
import {
  AgentActivityCluster,
  isAgentActivityMember,
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

export type DisplayUnit =
  | { type: "cluster"; messages: UIMessage[] }
  | { type: "single"; message: UIMessage }
  | { type: "single-with-activity"; message: UIMessage; activityMessages: UIMessage[]; turnLatencyMs?: number };

/** True when this unit index is the last assistant text slice before the next user message (or end of thread). */
export function isFinalAssistantSliceBeforeNextUser(
  units: DisplayUnit[],
  index: number,
): boolean {
  const u = units[index];
  if ((u.type !== "single" && u.type !== "single-with-activity") || u.message.role !== "assistant") return true;
  for (let j = index + 1; j < units.length; j++) {
    const v = units[j];
    if ((v.type === "single" || v.type === "single-with-activity") && v.message.role === "user") break;
    return false;
  }
  return true;
}

export function buildDisplayUnits(messages: UIMessage[]): DisplayUnit[] {
  const out: DisplayUnit[] = [];
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
    out.push({ type: "single", message: m });
    i += 1;
  }
  return out;
}

/**
 * 把 [cluster, single-assistant] 对折叠成 single-with-activity，
 * 让活动区（工具调用/推理）在回复气泡内部渲染，而不是浮在气泡上方。
 * liveClusterIndex 对应正在流式输出的 cluster，不折叠。
 */
function foldActivityIntoBubbles(units: DisplayUnit[], liveClusterIndex: number): DisplayUnit[] {
  const out: DisplayUnit[] = [];
  let i = 0;
  while (i < units.length) {
    const unit = units[i];
    const next = units[i + 1];
    if (
      unit.type === "cluster"
      && i !== liveClusterIndex
      && next?.type === "single"
      && next.message.role === "assistant"
    ) {
      const latency = activityClusterTurnLatencyMs(unit.messages, next);
      out.push({
        type: "single-with-activity",
        message: next.message,
        activityMessages: unit.messages,
        turnLatencyMs: latency,
      });
      i += 2;
      continue;
    }
    out.push(unit);
    i += 1;
  }
  return out;
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

export function assistantCopyFlags(units: DisplayUnit[]): boolean[] {
  const flags = new Array<boolean>(units.length).fill(true);
  let hasLaterUnitBeforeUser = false;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if ((unit.type === "single" || unit.type === "single-with-activity") && unit.message.role === "user") {
      hasLaterUnitBeforeUser = false;
      continue;
    }
    if ((unit.type === "single" || unit.type === "single-with-activity") && unit.message.role === "assistant") {
      flags[i] = !hasLaterUnitBeforeUser;
    }
    hasLaterUnitBeforeUser = true;
  }
  return flags;
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
  const rawUnits = useMemo(() => buildDisplayUnits(messages), [messages]);
  const liveActivityClusterIndex = useMemo(
    () => isStreaming ? currentActivityClusterIndex(rawUnits) : -1,
    [isStreaming, rawUnits],
  );
  const units = useMemo(
    () => foldActivityIntoBubbles(rawUnits, liveActivityClusterIndex),
    [rawUnits, liveActivityClusterIndex],
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
      {units.map((unit, index) => {
        const prev = units[index - 1];
        const marginTop =
          index > 0
            ? marginAfterPrevUnit(prev)
            : "";
        const next = units[index + 1];
        const hasBodyBelow =
          unit.type === "cluster"
          && next?.type === "single"
          && next.message.role === "assistant";
        const clusterLatencyMs =
          unit.type === "cluster" ? activityClusterTurnLatencyMs(unit.messages, next) : undefined;

        return (
          <div key={unitKey(unit, index)} className={marginTop}>
            {unit.type === "cluster" ? (
              <AgentActivityCluster
                messages={unit.messages}
                isTurnStreaming={index === liveActivityClusterIndex}
                hasBodyBelow={hasBodyBelow}
                turnLatencyMs={clusterLatencyMs}
                cliApps={cliApps}
                mcpPresets={mcpPresets}
              />
            ) : unit.type === "single-with-activity" ? (
              <MessageBubble
                message={unit.message}
                showAssistantCopyAction={copyFlags[index]}
                cliApps={cliApps}
                mcpPresets={mcpPresets}
                activityBefore={
                  <AgentActivityCluster
                    messages={unit.activityMessages}
                    isTurnStreaming={false}
                    hasBodyBelow={false}
                    turnLatencyMs={unit.turnLatencyMs}
                    cliApps={cliApps}
                    mcpPresets={mcpPresets}
                  />
                }
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
        );
      })}
    </div>
  );
}

function activityClusterTurnLatencyMs(
  messages: UIMessage[],
  next: DisplayUnit | undefined,
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const latency = messages[i].latencyMs;
    if (typeof latency === "number" && Number.isFinite(latency) && latency >= 0) {
      return latency;
    }
  }
  if (
    next?.type === "single"
    && next.message.role === "assistant"
    && typeof next.message.latencyMs === "number"
    && Number.isFinite(next.message.latencyMs)
    && next.message.latencyMs >= 0
  ) {
    return next.message.latencyMs;
  }
  return undefined;
}

function currentActivityClusterIndex(units: DisplayUnit[]): number {
  const last = units.length - 1;
  return units[last]?.type === "cluster" ? last : -1;
}

function unitKey(unit: DisplayUnit, index: number): string {
  if (unit.type === "cluster") {
    const anchor = unit.messages[0]?.id;
    return anchor != null ? `cluster-${anchor}` : `cluster-idx-${index}`;
  }
  return unit.message.id;
}

function marginAfterPrevUnit(prev: DisplayUnit): string {
  if (prev.type === "cluster") {
    return "mt-4";
  }
  const p = prev.message;
  const denseP =
    p.kind === "trace"
    || (
      p.role === "assistant"
      && p.content.trim().length === 0
      && (!!p.reasoning || !!p.reasoningStreaming)
    );
  if (denseP) {
    return "mt-2";
  }
  return "mt-5";
}
