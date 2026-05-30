import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { StreamErrorNotice } from "@/components/thread/StreamErrorNotice";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { ThreadViewport } from "@/components/thread/ThreadViewport";
import { useNanobotStream } from "@/hooks/useNanobotStream";
import { channelLabel } from "@/lib/channels";
import type { UIMessage } from "@/lib/types";

const INBOX_CHAT_ID = "inbox:unified";

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
}

export function InboxView({
  initialMessages,
  activeChannel,
  onChannelsChange,
  pendingScreenshot,
  onScreenshotConsumed,
  onCaptureScreenshot,
}: InboxViewProps) {
  const { t } = useTranslation();
  const {
    messages,
    isStreaming,
    runStartedAt,
    goalState,
    send,
    stop,
    streamError,
    dismissStreamError,
  } = useNanobotStream(INBOX_CHAT_ID, initialMessages);

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

  // Filter by selected channel
  const displayMessages = useMemo<UIMessage[]>(() => {
    if (!activeChannel) return messages;
    return messages.filter((m) => m.sourceChannel === activeChannel);
  }, [messages, activeChannel]);

  return (
    <div className="flex h-full flex-col">
      {/* Channel header strip — pt-2 + h-7 drag 与 InboxSidebar 首项图标垂直对齐 */}
      <div className="flex shrink-0 flex-col border-b border-border pt-2">
        <div
          className="h-7 w-full shrink-0"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />
        <div
          className="flex h-9 shrink-0 items-center px-4 text-sm font-medium text-foreground"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {activeChannel ? channelLabel(activeChannel) : t("inbox.unified")}
          </span>
        </div>
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
          composer={
            <ThreadComposer
              onSend={send}
              onStop={stop}
              isStreaming={isStreaming}
              runStartedAt={runStartedAt}
              goalState={goalState}
              pendingScreenshot={pendingScreenshot}
              onScreenshotConsumed={onScreenshotConsumed}
              onCaptureScreenshot={onCaptureScreenshot}
            />
          }
        />
      </div>
    </div>
  );
}

