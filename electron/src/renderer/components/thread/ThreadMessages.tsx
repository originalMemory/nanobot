import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  BotAvatarWithFallback,
  MessageBubble,
  resolveMediaUrl,
} from "@/components/MessageBubble";
import { MessageSourceBadge } from "@/components/MessageSourceBadge";
import { AgentActivityCluster } from "@/components/thread/AgentActivityCluster";
import { useBotIdentity } from "@/contexts/BotIdentityContext";
import { normalizeActivityTimeline, type TurnUnit } from "@/lib/activity-timeline";
import type { CliAppInfo, McpPresetInfo, UIMessage } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

interface ThreadMessagesProps {
  messages: UIMessage[];
  isStreaming?: boolean;
  hiddenMessageCount?: number;
  onLoadEarlier?: () => void;
  cliApps?: CliAppInfo[];
  mcpPresets?: McpPresetInfo[];
}

export type DisplayUnit = TurnUnit;

export function buildDisplayUnits(
  messages: UIMessage[],
  isStreaming = false,
): DisplayUnit[] {
  return normalizeActivityTimeline(messages, {
    preserveTrailingActivity: isStreaming,
  });
}

export function assistantTurnFooterFlags(
  units: DisplayUnit[],
): boolean[] {
  const flags = units.map(() => true);
  const assistantIndicesByTurn = new Map<string, number[]>();
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit.type !== "message" || unit.message.role !== "assistant") continue;
    const turnId = unit.message.turnId;
    if (!turnId) continue;
    const indices = assistantIndicesByTurn.get(turnId) ?? [];
    indices.push(index);
    assistantIndicesByTurn.set(turnId, indices);
  }
  for (const indices of assistantIndicesByTurn.values()) {
    for (const index of indices) flags[index] = false;
    const lastIndex = indices.at(-1);
    if (lastIndex !== undefined) flags[lastIndex] = true;
  }
  return flags;
}

/** 每轮只为首个 agent 展示单元返回一条可用于 identity/source 的消息。 */
export function assistantTurnHeaderMessages(units: DisplayUnit[]): Array<UIMessage | null> {
  const descriptors: Array<{
    index: number;
    turnId: string;
    messages: UIMessage[];
  }> = [];

  units.forEach((unit, index) => {
    if (unit.type === "message" && unit.message.role === "user") return;
    const messages = unit.type === "activity" ? unit.messages : [unit.message];
    const turnId = messages.find((message) => message.turnId)?.turnId;
    if (turnId) descriptors.push({ index, turnId, messages });
  });

  const sourceByTurn = new Map<string, UIMessage>();
  for (const descriptor of descriptors) {
    const candidate = descriptor.messages.find(hasMessageSource)
      ?? descriptor.messages.find((message) => message.role === "assistant")
      ?? descriptor.messages[0];
    if (!candidate) continue;
    const current = sourceByTurn.get(descriptor.turnId);
    if (!current || (!hasMessageSource(current) && hasMessageSource(candidate))) {
      sourceByTurn.set(descriptor.turnId, candidate);
    }
  }

  const headers = new Array<UIMessage | null>(units.length).fill(null);
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.turnId)) continue;
    seen.add(descriptor.turnId);
    headers[descriptor.index] = sourceByTurn.get(descriptor.turnId) ?? null;
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
  isStreaming = false,
  hiddenMessageCount = 0,
  onLoadEarlier,
  cliApps = [],
  mcpPresets = [],
}: ThreadMessagesProps) {
  const { t } = useTranslation();
  const units = useMemo(() => buildDisplayUnits(messages, isStreaming), [messages, isStreaming]);
  const footerFlags = useMemo(() => assistantTurnFooterFlags(units), [units]);
  const turnHeaderMessages = useMemo(() => assistantTurnHeaderMessages(units), [units]);
  const liveActivityClusterIndices = useMemo(
    () => isStreaming ? currentActivityClusterIndices(units) : new Set<number>(),
    [isStreaming, units],
  );

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
        const next = units[index + 1];
        const hasBodyBelow =
          unit.type === "activity"
          && next?.type === "message"
          && next.message.role === "assistant"
          && next.message.turnId === unit.messages[0]?.turnId;
        return (
          <div
            key={unitKey(unit, index)}
            className={index > 0 ? marginBetweenUnits(units[index - 1], unit) : ""}
            data-message-id={unitScrollMessageId(unit)}
          >
            {turnHeaderMessages[index] ? (
              <AssistantTurnHeader sourceMessage={turnHeaderMessages[index]} />
            ) : null}
            {unit.type === "activity" ? (
              <AgentActivityCluster
                messages={unit.messages}
                isTurnStreaming={liveActivityClusterIndices.has(index)}
                hasBodyBelow={hasBodyBelow}
                turnLatencyMs={unit.turnLatencyMs}
                startedAtMs={unit.startedAtMs}
                cliApps={cliApps}
                mcpPresets={mcpPresets}
              />
            ) : (
              <>
                <MessageBubble
                  message={unit.message}
                  showAssistantIdentity={false}
                  showAssistantFooter={footerFlags[index]}
                  cliApps={cliApps}
                  mcpPresets={mcpPresets}
                />
                {unit.message.role === "assistant"
                  && footerFlags[index]
                  && unit.message.responseModel ? (
                    <ResponseModelSummary message={unit.message} />
                  ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ResponseModelSummary({ message }: { message: UIMessage }) {
  const { t } = useTranslation();
  const model = message.responseModel ?? "";
  const title = message.responseProvider
    ? `${message.responseProvider}/${model}`
    : model;
  return (
    <div
      data-testid="response-model-summary"
      className="mt-1 flex min-h-5 items-center gap-1.5 text-[11px] text-muted-foreground/65"
      title={title}
    >
      <span>{t("thread.composer.responseModel", { model })}</span>
      {message.fallbackUsed ? (
        <span className="rounded-full border border-amber-400/35 bg-amber-400/10 px-1.5 py-0.5 font-medium leading-none text-amber-700/90 dark:text-amber-300/90">
          {t("thread.composer.fallbackUsed")}
        </span>
      ) : null}
    </div>
  );
}

function AssistantTurnHeader({ sourceMessage }: { sourceMessage: UIMessage }) {
  const { botName, botIcon, botAvatarUrl } = useBotIdentity();
  const { apiBase } = useClient();
  return (
    <div
      data-testid="assistant-turn-identity"
      className="mb-2 flex min-h-9 items-center gap-2 text-muted-foreground"
    >
      <BotAvatarWithFallback
        name={botName}
        icon={botIcon}
        avatarUrl={resolveMediaUrl(botAvatarUrl ?? undefined, apiBase)}
      />
      <span className="text-base font-medium text-rose-500/85 dark:text-rose-300/85">
        {botName}
      </span>
      <MessageSourceBadge message={sourceMessage} />
    </div>
  );
}

function currentActivityClusterIndices(units: DisplayUnit[]): Set<number> {
  const indices = new Set<number>();
  const activeTurns = new Set(
    units.flatMap((unit) => {
      if (unit.type === "message") {
        return unit.message.isStreaming && unit.message.turnId ? [unit.message.turnId] : [];
      }
      return unit.messages.some((message) => message.isStreaming || message.reasoningStreaming)
        && unit.messages[0]?.turnId
        ? [unit.messages[0].turnId]
        : [];
    }),
  );
  if (activeTurns.size === 0) {
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index];
      if (unit.type === "activity") {
        indices.add(index);
        break;
      }
      if (unit.message.role === "user") break;
    }
    return indices;
  }
  units.forEach((unit, index) => {
    if (unit.type === "activity" && unit.messages[0]?.turnId && activeTurns.has(unit.messages[0].turnId)) {
      indices.add(index);
    }
  });
  return indices;
}

function unitScrollMessageId(unit: DisplayUnit): string | undefined {
  return unit.type === "message" ? unit.message.id : unit.messages[0]?.id;
}

function unitKey(unit: DisplayUnit, index: number): string {
  if (unit.type === "message") return unit.message.id;
  const anchor = unit.messages[0];
  return anchor ? `activity-${anchor.turnId}-${anchor.id}` : `activity-${index}`;
}

function marginBetweenUnits(previous: DisplayUnit, current: DisplayUnit): string {
  if (previous.type === "activity") {
    const activityTurnId = previous.messages[0]?.turnId;
    if (
      current.type === "message"
      && current.message.role === "assistant"
      && !!activityTurnId
      && current.message.turnId === activityTurnId
    ) {
      return "";
    }
    return "mt-4";
  }
  const message = previous.message;
  if (
    current.type === "message"
    && message.role === "assistant"
    && current.message.role === "assistant"
    && !!message.turnId
    && message.turnId === current.message.turnId
  ) {
    return "mt-3";
  }
  if (
    message.kind === "trace"
    || (
      message.role === "assistant"
      && message.content.trim().length === 0
      && (!!message.reasoning || !!message.reasoningStreaming)
    )
  ) {
    return "mt-2";
  }
  return "mt-5";
}
