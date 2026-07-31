import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StreamErrorNotice } from "@/components/thread/StreamErrorNotice";
import { ThreadComposer, type ThreadComposerHandle } from "@/components/thread/ThreadComposer";
import { ThreadViewport } from "@/components/thread/ThreadViewport";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useNanobotStream, type SendImage, type SendOptions } from "@/hooks/useNanobotStream";
import { usePsbTagEffects } from "@/hooks/usePsbTagEffects";
import { ApiError, fetchCliApps, fetchInboxThread, fetchMcpPresets, listSlashCommands } from "@/lib/api";
import { channelLabel } from "@/lib/channels";
import type { ReasoningEffortValue } from "@/lib/reasoning-effort";
import type { CliAppInfo, McpPresetInfo, SettingsPayload, SlashCommand, UIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";

const INBOX_CHAT_ID = "inbox:unified";
const TOAST_DURATION_MS = 3_500;

interface InboxViewProps {
  initialMessages: UIMessage[];
  /** null = 统一收件箱（all channels），string = filter to that channel */
  activeChannel: string | null;
  onChannelsChange?: (channels: string[]) => void;
  /** 待附加到 Composer 的截图 data URL（8.2） */
  pendingScreenshot?: string | null;
  onScreenshotConsumed?: () => void;
  /** 点击截图按钮时触发，由 Shell 负责调用 electronAPI 并展示确认弹窗。 */
  onCaptureScreenshot?: () => void;
  modelSettings?: SettingsPayload | null;
  modelSelectionPending?: boolean;
  modelSelectionError?: string | null;
  onDismissModelSelectionError?: () => void;
  onModelPresetSelect?: (preset: string) => void;
  reasoningSelectionPending?: boolean;
  reasoningSelectionError?: string | null;
  onDismissReasoningSelectionError?: () => void;
  onReasoningEffortSelect?: (effort: ReasoningEffortValue) => void;
  /** 递增时聚焦输入框（全局快捷键唤起收件箱）。 */
  focusComposerSignal?: number;
}

export function InboxView({
  initialMessages,
  activeChannel,
  onChannelsChange,
  pendingScreenshot,
  onScreenshotConsumed,
  onCaptureScreenshot,
  modelSettings,
  modelSelectionPending,
  modelSelectionError,
  onDismissModelSelectionError,
  onModelPresetSelect,
  reasoningSelectionPending,
  reasoningSelectionError,
  onDismissReasoningSelectionError,
  onReasoningEffortSelect,
  focusComposerSignal = 0,
}: InboxViewProps) {
  const { t } = useTranslation();
  const composerRef = useRef<ThreadComposerHandle>(null);
  const { token, apiBase } = useClient();
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [cliApps, setCliApps] = useState<CliAppInfo[]>([]);
  const [mcpPresets, setMcpPresets] = useState<McpPresetInfo[]>([]);
  const psbTurnEndRef = useRef<() => void>(() => {});
  const psbSkipHistoryRef = useRef<() => void>(() => {});
  const {
    messages,
    isStreaming,
    runStartedAt,
    goalState,
    turnModelName,
    turnModelProvider,
    send,
    stop,
    replaceMessagesFromSnapshot,
    streamError,
    dismissStreamError,
  } = useNanobotStream(
    INBOX_CHAT_ID,
    initialMessages,
    false,
    () => psbTurnEndRef.current(),
    activeChannel,
  );
  usePsbTagEffects(messages, modelSettings, psbTurnEndRef, psbSkipHistoryRef, isStreaming);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastMessage(message);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToastMessage(null);
    }, TOAST_DURATION_MS);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  const handleRefreshHistory = useCallback(async () => {
    if (isStreaming || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const thread = await fetchInboxThread(token, apiBase);
      if (thread === null) {
        showToast(t("inbox.refreshHistoryNotFound"));
        return;
      }
      replaceMessagesFromSnapshot(thread.messages ?? []);
      psbSkipHistoryRef.current();
      setScrollToBottomSignal((value) => value + 1);
    } catch (err) {
      console.warn("[nanobot] fetchInboxThread refresh failed:", err);
      if (err instanceof ApiError && err.status === 404) {
        showToast(t("inbox.refreshHistoryNotFound"));
        return;
      }
      showToast(t("inbox.refreshHistoryFailed"));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [apiBase, isStreaming, replaceMessagesFromSnapshot, showToast, t, token]);

  const handleSend = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      setScrollToBottomSignal((value) => value + 1);
      send(content, images, options);
    },
    [send],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cmds, apps, presets] = await Promise.allSettled([
        listSlashCommands(token, apiBase),
        fetchCliApps(token, apiBase),
        fetchMcpPresets(token, apiBase),
      ]);
      if (cancelled) return;
      setSlashCommands(cmds.status === "fulfilled" ? cmds.value : []);
      setCliApps(
        apps.status === "fulfilled"
          ? apps.value.apps.filter((app) => app.installed)
          : [],
      );
      setMcpPresets(
        presets.status === "fulfilled"
          ? presets.value.presets.filter((p) => p.installed && p.configured)
          : [],
      );
    })();
    return () => { cancelled = true; };
  }, [apiBase, token]);

  // Derive unique channels from message history (7.5 sidebar entries)
  const allChannels = useMemo(() => {
    const seen = new Set<string>();
    for (const m of messages) {
      if (m.sourceChannel) seen.add(m.sourceChannel);
    }
    return Array.from(seen).sort();
  }, [messages]);

  useEffect(() => {
    onChannelsChange?.(allChannels);
  }, [allChannels, onChannelsChange]);

  useEffect(() => {
    if (!focusComposerSignal) return;
    const id = requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [focusComposerSignal]);

  // Filter by selected channel
  const displayMessages = useMemo<UIMessage[]>(() => {
    if (!activeChannel) return messages;
    return messages.filter((m) => m.sourceChannel === activeChannel);
  }, [messages, activeChannel]);

  const refreshDisabled = isStreaming || refreshing;
  const refreshTooltip = isStreaming
    ? t("inbox.refreshHistoryDisabledStreaming")
    : t("inbox.refreshHistory");

  return (
    <div className="flex h-full flex-col">
      {toastMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full border border-border/70 bg-popover px-4 py-2 text-sm font-medium text-popover-foreground shadow-lg"
        >
          {toastMessage}
        </div>
      ) : null}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border/60 bg-sidebar px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {activeChannel ? channelLabel(activeChannel) : t("inbox.unified")}
        </span>
        <TooltipProvider delayDuration={400}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={refreshDisabled}
                  aria-label={refreshTooltip}
                  onClick={() => {
                    void handleRefreshHistory();
                  }}
                >
                  <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {refreshTooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Thread + Composer (ThreadViewport owns the layout) */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {streamError && (
          <StreamErrorNotice
            error={streamError}
            onDismiss={dismissStreamError}
          />
        )}
        <ThreadViewport
          messages={displayMessages}
          isStreaming={isStreaming}
          scrollToBottomSignal={scrollToBottomSignal}
          cliApps={cliApps}
          mcpPresets={mcpPresets}
          composer={
            <ThreadComposer
              ref={composerRef}
              onSend={handleSend}
              onStop={stop}
              isStreaming={isStreaming}
              runStartedAt={runStartedAt}
              goalState={goalState}
              pendingScreenshot={pendingScreenshot}
              onScreenshotConsumed={onScreenshotConsumed}
              onCaptureScreenshot={onCaptureScreenshot}
              slashCommands={slashCommands}
              cliApps={cliApps}
              mcpPresets={mcpPresets}
              modelSettings={modelSettings}
              turnModelName={turnModelName}
              turnModelProvider={turnModelProvider}
              modelSelectionPending={modelSelectionPending}
              modelSelectionError={modelSelectionError}
              onDismissModelSelectionError={onDismissModelSelectionError}
              onModelPresetSelect={onModelPresetSelect}
              reasoningSelectionPending={reasoningSelectionPending}
              reasoningSelectionError={reasoningSelectionError}
              onDismissReasoningSelectionError={onDismissReasoningSelectionError}
              onReasoningEffortSelect={onReasoningEffortSelect}
            />
          }
        />
      </div>
    </div>
  );
}
