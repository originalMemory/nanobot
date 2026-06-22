import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssistantNameRow } from "@/components/AssistantNameRow";
import { BotAvatarWithFallback, MessageMedia, resolveMediaUrl } from "@/components/MessageBubble";
import { MarkdownText } from "@/components/MarkdownText";
import { AgentActivityCluster } from "@/components/thread/AgentActivityCluster";
import { useBotIdentity } from "@/contexts/BotIdentityContext";
import { formatTurnLatency } from "@/lib/format";
import { pickMessageSourceFields } from "@/lib/message-source";
import {
  buildTokenUsageTitle,
  displayCacheRead,
  displayCompletionOut,
  displayPromptIn,
} from "@/lib/turn-usage";
import { cn, formatTokenCount } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { CliAppInfo, McpPresetInfo, UIMessage } from "@/lib/types";

export type TurnSegment =
  | { kind: "activity"; messages: UIMessage[]; turnLatencyMs?: number }
  | { kind: "text"; message: UIMessage };

interface AssistantTurnBubbleProps {
  segments: TurnSegment[];
  /** 整轮 assistant turn 是否仍在流式输出中 */
  isTurnStreaming?: boolean;
  showCopyAction?: boolean;
  cliApps?: CliAppInfo[];
  mcpPresets?: McpPresetInfo[];
}

/** 一轮 assistant 回复：单 SAP 气泡内按时间序交错 activity / 正文段。 */
export function AssistantTurnBubble({
  segments,
  isTurnStreaming = false,
  showCopyAction = true,
  cliApps = [],
  mcpPresets = [],
}: AssistantTurnBubbleProps) {
  const { t } = useTranslation();
  const { botName, botIcon, botAvatarUrl } = useBotIdentity();
  const { apiBase } = useClient();
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const baseAnim = "animate-in fade-in-0 slide-in-from-bottom-1 duration-300";

  const textSegments = useMemo(
    () => segments.filter((s): s is Extract<TurnSegment, { kind: "text" }> => s.kind === "text"),
    [segments],
  );
  const footerMessage = textSegments.at(-1)?.message;
  const sourceMessage = pickMessageSourceFields(
    textSegments.map((segment) => segment.message),
  );
  const copyText = useMemo(
    () => textSegments.map((s) => s.message.content).filter((c) => c.trim()).join("\n\n"),
    [textSegments],
  );

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const onCopyAssistantReply = useCallback(() => {
    if (!navigator.clipboard || !copyText) return;
    void navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetRef.current = null;
      }, 1_500);
    });
  }, [copyText]);

  const lastSegmentIndex = segments.length - 1;
  const showTypingTail =
    isTurnStreaming
    && lastSegmentIndex >= 0
    && segments[lastSegmentIndex].kind === "text"
    && segments[lastSegmentIndex].message.content.trim().length === 0
    && (segments[lastSegmentIndex].message.media?.length ?? 0) === 0
    && !segments[lastSegmentIndex].message.reasoning?.trim();

  if (isTurnStreaming && segments.length === 0) {
    return (
      <div className={cn("flex w-full gap-2 text-[15px]", baseAnim)} style={{ lineHeight: "var(--cjk-line-height)" }}>
        <div className="flex w-10 flex-none items-start pt-0.5">
          <BotAvatarWithFallback
            name={botName}
            icon={botIcon}
            avatarUrl={resolveMediaUrl(botAvatarUrl ?? undefined, apiBase)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <AssistantNameRow botName={botName} message={sourceMessage} />
          <div className="rounded-[18px_18px_18px_4px] border border-border chat-ai-bubble px-4 py-3 [letter-spacing:0.3px]">
            <TypingDots />
          </div>
        </div>
      </div>
    );
  }

  const latencyMs = footerMessage?.latencyMs;
  const usage = footerMessage?.usage;
  const messageTs = footerMessage?.messageTs;
  const turnComplete = !isTurnStreaming;
  const hasFooterText = textSegments.some((s) => s.message.content.trim().length > 0);
  const hasFooterMedia = textSegments.some((s) => (s.message.media?.length ?? 0) > 0);
  const footerCondition = turnComplete && (hasFooterText || hasFooterMedia);
  const showCopyButton = showCopyAction && turnComplete && copyText.trim().length > 0;
  const showLatencyFooter = footerCondition && latencyMs != null;
  const showUsageFooter = footerCondition && usage != null;
  const showTimestampFooter = footerCondition && messageTs != null;
  const showAssistantFooterRow = showCopyButton || showLatencyFooter || showUsageFooter || showTimestampFooter;
  return (
    <div className={cn("flex w-full gap-2 text-[15px]", baseAnim)} style={{ lineHeight: "var(--cjk-line-height)" }}>
      <div className="flex w-10 flex-none items-start pt-0.5">
        <BotAvatarWithFallback
          name={botName}
          icon={botIcon}
          avatarUrl={resolveMediaUrl(botAvatarUrl ?? undefined, apiBase)}
        />
      </div>
      <div className="min-w-0 flex-1">
        <AssistantNameRow botName={botName} message={sourceMessage} />
        <div className="rounded-[18px_18px_18px_4px] border border-border chat-ai-bubble px-4 py-3 [letter-spacing:0.3px]">
          <div className="flex flex-col gap-2">
            {segments.map((segment, index) => {
              if (segment.kind === "activity") {
                const hasBodyBelow = segments[index + 1]?.kind === "text";
                const segmentLive = isTurnStreaming && index === lastSegmentIndex;
                return (
                  <AgentActivityCluster
                    key={`activity-${segment.messages[0]?.id ?? index}`}
                    messages={segment.messages}
                    isTurnStreaming={segmentLive}
                    hasBodyBelow={hasBodyBelow}
                    turnLatencyMs={segment.turnLatencyMs}
                    cliApps={cliApps}
                    mcpPresets={mcpPresets}
                  />
                );
              }
              const { message } = segment;
              const textEmpty = message.content.trim().length === 0;
              const media = message.media ?? [];
              const hasMedia = media.length > 0;
              if (textEmpty && !hasMedia) {
                return null;
              }
              return (
                <div key={message.id}>
                  {!textEmpty ? (
                    <MarkdownText streaming={!!message.isStreaming}>
                      {message.content}
                    </MarkdownText>
                  ) : null}
                  {hasMedia ? (
                    <MessageMedia media={media} align="left" thaSourceText={message.content} />
                  ) : null}
                </div>
              );
            })}
            {showTypingTail ? <TypingDots /> : null}
          </div>
        </div>
        {showAssistantFooterRow ? (
          <div className="mt-2 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            {showCopyButton ? (
              <button
                type="button"
                onClick={onCopyAssistantReply}
                aria-label={copied ? t("message.copiedReply") : t("message.copyReply")}
                title={copied ? t("message.copiedReply") : t("message.copyReply")}
                className={cn(
                  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  "transition-colors hover:bg-muted/55 hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
              </button>
            ) : null}
            {showTimestampFooter ? (
              <MessageTimestamp ts={messageTs!} />
            ) : null}
            {showUsageFooter ? (
              <TokenUsageFooter usage={usage!} />
            ) : null}
            {showLatencyFooter ? (
              <span
                className="text-[11px] leading-none text-muted-foreground/70 tabular-nums"
                title={t("message.turnLatencyTitle")}
              >
                {formatTurnLatency(latencyMs!)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{ animationDelay: `${i * 120}ms` }}
          className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
        />
      ))}
    </span>
  );
}

function formatMessageTimestamp(ts: string | number): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${mo}-${dd} ${hh}:${mm}:${ss}`;
}

function MessageTimestamp({ ts }: { ts: string | number }) {
  const formatted = formatMessageTimestamp(ts);
  if (!formatted) return null;
  return (
    <span className="text-[11px] leading-none text-muted-foreground/50 tabular-nums" title={String(ts)}>
      {formatted}
    </span>
  );
}

function TokenUsageFooter({ usage }: { usage: NonNullable<UIMessage["usage"]> }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  const promptIn = displayPromptIn(usage);
  const completionOut = displayCompletionOut(usage);
  const cacheRead = displayCacheRead(usage);

  if (promptIn > 0) {
    parts.push(`↑${formatTokenCount(promptIn)}`);
  }
  if (completionOut > 0) {
    parts.push(`↓${formatTokenCount(completionOut)}`);
  }
  if (cacheRead > 0) {
    parts.push(`R${formatTokenCount(cacheRead)}`);
  }
  if (usage.context_pct != null && usage.context_pct >= 0) {
    parts.push(`${usage.context_pct}% ctx`);
  }

  if (parts.length === 0) return null;

  return (
    <span
      className="text-[11px] leading-none text-muted-foreground/60 tabular-nums"
      title={buildTokenUsageTitle(usage, t)}
    >
      {parts.join(" ")}
    </span>
  );
}
