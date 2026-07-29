import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBubble } from "@/components/MessageBubble";
import { MessageSourceBadge } from "@/components/MessageSourceBadge";
import { AgentActivityCluster } from "@/components/thread/AgentActivityCluster";
import { AssistantSelectionAction } from "@/components/thread/AssistantSelectionAction";
import { normalizeActivityTimeline, type TurnUnit } from "@/lib/activity-timeline";
import type { CliAppInfo, McpPresetInfo, SlashCommand, UIMessage } from "@/lib/types";
import { isNativeRuntime } from "@/lib/runtime";

interface ThreadMessagesProps {
  messages: UIMessage[];
  assistantIdentity?: AssistantIdentity;
  /** When true, agent turn still in flight — keeps activity timeline expanded. */
  isStreaming?: boolean;
  hiddenUserMessageCount?: number;
  cliApps?: CliAppInfo[];
  mcpPresets?: McpPresetInfo[];
  slashCommands?: SlashCommand[];
  forkBoundaryMessageCount?: number | null;
  onOpenFilePreview?: (path: string) => void;
  onForkFromMessage?: (beforeUserIndex: number) => void;
  onQuoteSelection?: (text: string) => void;
}

export type DisplayUnit = TurnUnit;

export interface AssistantIdentity {
  name: string;
  icon: string;
  avatarUrl?: string | null;
}

export function buildDisplayUnits(
  messages: UIMessage[],
  isStreaming = false,
): DisplayUnit[] {
  return normalizeActivityTimeline(messages, {
    preserveTrailingActivity: isStreaming,
  });
}

export function assistantForkFlags(units: DisplayUnit[]): boolean[] {
  const flags = new Array<boolean>(units.length).fill(true);
  let hasLaterUnitBeforeUser = false;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit.type === "message" && unit.message.role === "user") {
      hasLaterUnitBeforeUser = false;
      continue;
    }
    if (unit.type === "message" && unit.message.role === "assistant") {
      flags[i] = !hasLaterUnitBeforeUser;
    }
    hasLaterUnitBeforeUser = true;
  }
  return flags;
}

/** 每轮只为首个 agent 展示单元返回一条可用于 identity/source 的消息。 */
export function assistantTurnHeaderMessages(units: DisplayUnit[]): Array<UIMessage | null> {
  const descriptors: Array<{
    index: number;
    key: string;
    messages: UIMessage[];
  }> = [];
  let legacyTurn = 0;
  let activeTurnKey: string | null = null;

  units.forEach((unit, index) => {
    if (unit.type === "message" && unit.message.role === "user") {
      legacyTurn += 1;
      activeTurnKey = unit.message.turnId
        ? `turn:${unit.message.turnId}`
        : `legacy:${legacyTurn}`;
      return;
    }
    const messages = unit.type === "activity" ? unit.messages : [unit.message];
    const explicitTurnId = messages.find((message) => message.turnId)?.turnId;
    const proactiveMessage = unit.type === "message"
      && unit.message.role === "assistant"
      && unit.message.channelDelivery
      ? unit.message
      : null;
    if (explicitTurnId) {
      activeTurnKey = `turn:${explicitTurnId}`;
    } else if (proactiveMessage) {
      legacyTurn += 1;
      activeTurnKey = `delivery:${legacyTurn}:${proactiveMessage.id}`;
    }
    activeTurnKey ??= `legacy:${legacyTurn}`;
    descriptors.push({ index, key: activeTurnKey, messages });
  });

  const sourceByTurn = new Map<string, UIMessage>();
  for (const descriptor of descriptors) {
    const candidate = descriptor.messages.find(hasMessageSource)
      ?? descriptor.messages.find((message) => message.role === "assistant")
      ?? descriptor.messages[0];
    if (candidate && (!sourceByTurn.has(descriptor.key) || hasMessageSource(candidate))) {
      const current = sourceByTurn.get(descriptor.key);
      if (!current || !hasMessageSource(current)) {
        sourceByTurn.set(descriptor.key, candidate);
      }
    }
  }

  const headers = new Array<UIMessage | null>(units.length).fill(null);
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.key)) continue;
    seen.add(descriptor.key);
    headers[descriptor.index] = sourceByTurn.get(descriptor.key) ?? null;
  }
  return headers;
}

function hasMessageSource(message: UIMessage): boolean {
  return Boolean(
    message.sourceChannel?.trim()
    || message.cronJobName?.trim()
    || message.channelDelivery
    || message.userInitiatedDelivery,
  );
}

export function ThreadMessages({
  messages,
  assistantIdentity,
  isStreaming = false,
  hiddenUserMessageCount = 0,
  cliApps = [],
  mcpPresets = [],
  slashCommands = [],
  forkBoundaryMessageCount = null,
  onOpenFilePreview,
  onForkFromMessage,
  onQuoteSelection,
}: ThreadMessagesProps) {
  const { t } = useTranslation();
  const messageListRef = useRef<HTMLDivElement>(null);
  const units = useMemo(() => buildDisplayUnits(messages, isStreaming), [isStreaming, messages]);
  const forkBoundaryAfterUnitIndex = useMemo(
    () => unitIndexAfterMessageCount(units, forkBoundaryMessageCount),
    [forkBoundaryMessageCount, units],
  );
  const forkFlags = useMemo(() => assistantForkFlags(units), [units]);
  const turnHeaderMessages = useMemo(
    () => assistantTurnHeaderMessages(units),
    [units],
  );
  const liveActivityClusterIndices = useMemo(
    () => isStreaming ? currentActivityClusterIndices(units) : new Set<number>(),
    [isStreaming, units],
  );
  const unitKeys = useMemo(() => unitKeysForDisplay(units), [units]);
  let nextUserIndex = hiddenUserMessageCount;

  return (
    <div ref={messageListRef} className="flex w-full flex-col">
      <AssistantSelectionAction
        containerRef={messageListRef}
        onQuoteSelection={onQuoteSelection}
      />
      {units.map((unit, index) => {
        const prev = units[index - 1];
        const marginTop =
          index > 0
            ? marginAfterPrevUnit(prev)
            : "";
        const next = units[index + 1];
        const hasBodyBelow =
          unit.type === "activity"
          && next?.type === "message"
          && next.message.role === "assistant";

        const userPromptId =
          unit.type === "message" && unit.message.role === "user"
            ? unit.message.id
            : undefined;
        const forkIndex =
          unit.type === "message" && unit.message.role === "assistant" && forkFlags[index]
            ? nextUserIndex
            : undefined;
        if (unit.type === "message" && unit.message.role === "user") nextUserIndex += 1;

        return (
          <ThreadDisplayUnit
            key={unitKeys[index]}
            unit={unit}
            assistantIdentity={assistantIdentity}
            turnHeaderMessage={turnHeaderMessages[index]}
            marginTop={marginTop}
            userPromptId={userPromptId}
            hasBodyBelow={hasBodyBelow}
            isTurnStreaming={liveActivityClusterIndices.has(index)}
            forkIndex={forkIndex}
            showForkBoundary={index === forkBoundaryAfterUnitIndex}
            forkBoundaryLabel={t("thread.forkedFromHistory")}
            cliApps={cliApps}
            mcpPresets={mcpPresets}
            slashCommands={slashCommands}
            onOpenFilePreview={onOpenFilePreview}
            onForkFromMessage={onForkFromMessage}
          />
        );
      })}
    </div>
  );
}

interface ThreadDisplayUnitProps {
  unit: DisplayUnit;
  assistantIdentity?: AssistantIdentity;
  turnHeaderMessage?: UIMessage | null;
  marginTop: string;
  userPromptId?: string;
  hasBodyBelow: boolean;
  isTurnStreaming: boolean;
  forkIndex?: number;
  showForkBoundary: boolean;
  forkBoundaryLabel: string;
  cliApps: CliAppInfo[];
  mcpPresets: McpPresetInfo[];
  slashCommands: SlashCommand[];
  onOpenFilePreview?: (path: string) => void;
  onForkFromMessage?: (beforeUserIndex: number) => void;
}

const ThreadDisplayUnit = memo(function ThreadDisplayUnit({
  unit,
  assistantIdentity,
  turnHeaderMessage,
  marginTop,
  userPromptId,
  hasBodyBelow,
  isTurnStreaming,
  forkIndex,
  showForkBoundary,
  forkBoundaryLabel,
  cliApps,
  mcpPresets,
  slashCommands,
  onOpenFilePreview,
  onForkFromMessage,
}: ThreadDisplayUnitProps) {
  const onForkFromHere = useCallback(() => {
    if (forkIndex !== undefined) onForkFromMessage?.(forkIndex);
  }, [forkIndex, onForkFromMessage]);
  const deferOffscreenRender = unit.type === "activity"
    ? !isTurnStreaming
    : unit.message.role === "assistant" && !unit.message.isStreaming;

  return (
    <>
      <div
        className={`${marginTop}${deferOffscreenRender ? " thread-render-unit" : ""}`}
        data-user-prompt-id={userPromptId}
      >
        {assistantIdentity && turnHeaderMessage ? (
          <AssistantTurnHeader
            identity={assistantIdentity}
            sourceMessage={turnHeaderMessage}
          />
        ) : null}
        {unit.type === "activity" ? (
          <AgentActivityCluster
            messages={unit.messages}
            isTurnStreaming={isTurnStreaming}
            hasBodyBelow={hasBodyBelow}
            turnLatencyMs={unit.turnLatencyMs}
            startedAtMs={unit.startedAtMs}
            cliApps={cliApps}
            mcpPresets={mcpPresets}
            onOpenFilePreview={onOpenFilePreview}
          />
        ) : (
          <MessageBubble
            message={unit.message}
            showSourceBadge={!assistantIdentity || unit.message.role === "user"}
            cliApps={cliApps}
            mcpPresets={mcpPresets}
            slashCommands={slashCommands}
            onOpenFilePreview={onOpenFilePreview}
            onForkFromHere={forkIndex !== undefined ? onForkFromHere : undefined}
          />
        )}
      </div>
      {showForkBoundary && !isNativeRuntime() ? (
        <ForkBoundaryDivider label={forkBoundaryLabel} />
      ) : null}
    </>
  );
}, threadDisplayUnitPropsEqual);

function threadDisplayUnitPropsEqual(
  previous: ThreadDisplayUnitProps,
  next: ThreadDisplayUnitProps,
): boolean {
  return (
    displayUnitsEqual(previous.unit, next.unit)
    && previous.assistantIdentity === next.assistantIdentity
    && previous.turnHeaderMessage === next.turnHeaderMessage
    && previous.marginTop === next.marginTop
    && previous.userPromptId === next.userPromptId
    && previous.hasBodyBelow === next.hasBodyBelow
    && previous.isTurnStreaming === next.isTurnStreaming
    && previous.forkIndex === next.forkIndex
    && previous.showForkBoundary === next.showForkBoundary
    && previous.forkBoundaryLabel === next.forkBoundaryLabel
    && previous.cliApps === next.cliApps
    && previous.mcpPresets === next.mcpPresets
    && previous.slashCommands === next.slashCommands
    && previous.onOpenFilePreview === next.onOpenFilePreview
    && previous.onForkFromMessage === next.onForkFromMessage
  );
}

function AssistantTurnHeader({
  identity,
  sourceMessage,
}: {
  identity: AssistantIdentity;
  sourceMessage: UIMessage;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarUrl = identity.avatarUrl?.trim();
  const fallback = identity.icon.trim() || identity.name.trim().charAt(0).toUpperCase() || "N";
  useEffect(() => setAvatarFailed(false), [avatarUrl]);

  return (
    <div
      data-testid="assistant-turn-identity"
      className="mb-2 flex min-h-9 items-center gap-2 text-muted-foreground"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-sm font-medium">
        {avatarUrl && !avatarFailed ? (
          <img
            src={avatarUrl}
            alt={identity.name}
            className="h-full w-full object-cover"
            onError={() => setAvatarFailed(true)}
          />
        ) : fallback}
      </span>
      <span className="text-base font-medium text-rose-500/85 dark:text-rose-300/85">
        {identity.name}
      </span>
      <MessageSourceBadge message={sourceMessage} inline />
    </div>
  );
}

function displayUnitsEqual(previous: DisplayUnit, next: DisplayUnit): boolean {
  if (previous.type !== next.type) return false;
  if (previous.type === "message" && next.type === "message") {
    return shallowMessageEqual(previous.message, next.message);
  }
  if (previous.type !== "activity" || next.type !== "activity") return false;
  return (
    previous.turnLatencyMs === next.turnLatencyMs
    && previous.startedAtMs === next.startedAtMs
    && previous.messages.length === next.messages.length
    && previous.messages.every((message, index) =>
      shallowMessageEqual(message, next.messages[index]))
  );
}

function shallowMessageEqual(previous: UIMessage, next: UIMessage): boolean {
  if (previous === next) return true;
  const previousKeys = Object.keys(previous) as Array<keyof UIMessage>;
  const nextKeys = Object.keys(next) as Array<keyof UIMessage>;
  return previousKeys.length === nextKeys.length
    && previousKeys.every((key) => previous[key] === next[key]);
}

function unitIndexAfterMessageCount(
  units: DisplayUnit[],
  messageCount: number | null | undefined,
): number | null {
  if (messageCount == null || messageCount <= 0) return null;
  let seen = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    seen += unit.type === "activity" ? unit.messages.length : 1;
    if (seen >= messageCount) return i;
  }
  return null;
}

function ForkBoundaryDivider({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-[11px] text-muted-foreground/80">
      <span aria-hidden className="h-px flex-1 bg-border/70" />
      <span className="shrink-0">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function currentActivityClusterIndices(units: DisplayUnit[]): Set<number> {
  const indices = new Set<number>();
  let markedCurrentActivity = false;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit.type === "activity") {
      if (!markedCurrentActivity) {
        indices.add(i);
        markedCurrentActivity = true;
      }
      continue;
    }
    if (unit.message.role === "assistant" && unit.message.isStreaming) continue;
    if (unit.message.role === "user") break;
  }
  return indices;
}

export function unitKeysForDisplay(units: DisplayUnit[]): string[] {
  const occurrences = new Map<string, number>();
  return units.map((unit, index) => {
    const base = unitKeyBase(unit, index);
    if (!base.startsWith("turn-") || base.endsWith("-user")) return base;
    const next = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, next);
    return `${base}-${next}`;
  });
}

function unitKeyBase(unit: DisplayUnit, index: number): string {
  if (unit.type === "activity") {
    const anchor = unit.messages[0];
    const turnKey = stableTurnMessageKey(anchor, "activity");
    if (turnKey) return turnKey;
    const anchorId = anchor?.id;
    return anchorId != null ? `activity-${anchorId}` : `activity-idx-${index}`;
  }
  const turnKey = stableTurnMessageKey(unit.message);
  if (turnKey) return turnKey;
  return unit.message.id;
}

function stableTurnMessageKey(message: UIMessage | undefined, fallbackPhase?: string): string | null {
  if (!message?.turnId) return null;
  const phase = message.turnPhase ?? fallbackPhase ?? message.kind ?? message.role;
  if (message.role === "user") return `turn-${message.turnId}-user`;
  if (message.kind === "trace") {
    return `turn-${message.turnId}-${phase}-${message.activitySegmentId ?? "activity"}`;
  }
  return `turn-${message.turnId}-${phase}`;
}

function marginAfterPrevUnit(prev: DisplayUnit): string {
  if (prev.type === "activity") {
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
