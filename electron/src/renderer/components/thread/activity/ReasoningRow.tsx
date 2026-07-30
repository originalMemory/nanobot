import { useEffect, useRef, useState } from "react";
import { Check, CircleDashed } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MarkdownText, preloadMarkdownText } from "@/components/MarkdownText";
import { StreamingLabelSheen } from "@/components/MessageBubble";
import { cn } from "@/lib/utils";

export function ReasoningRow({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  useEffect(() => {
    if (text.length > 0) preloadMarkdownText();
  }, [text.length]);
  return (
    <div className="min-w-0 py-0.5">
      <div className="flex min-w-0 items-center gap-2 text-[13px] leading-5 text-muted-foreground/78">
        <ReasoningMarker streaming={streaming} />
        <StreamingLabelSheen active={streaming} className="min-w-0 font-medium">
          {streaming ? t("message.reasoningStreaming") : t("message.reasoning")}
        </StreamingLabelSheen>
      </div>
      {text.trim() ? (
        <MarkdownText
          streaming={streaming}
          className={cn(
            "mt-1 min-w-0 pl-5 text-[12.5px] italic text-muted-foreground/78",
            "prose-p:my-1 prose-li:my-0.5",
            "prose-headings:mt-2 prose-headings:mb-1 prose-headings:font-medium",
            "prose-headings:text-muted-foreground/88 prose-strong:text-muted-foreground",
            "prose-h1:text-[15px] prose-h2:text-[13.5px] prose-h3:text-[12.5px]",
          )}
        >
          {text}
        </MarkdownText>
      ) : null}
    </div>
  );
}

function ReasoningMarker({ streaming }: { streaming: boolean }) {
  const wasStreamingRef = useRef(streaming);
  const [justCompleted, setJustCompleted] = useState(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      setJustCompleted(true);
      const timeout = window.setTimeout(() => setJustCompleted(false), 650);
      wasStreamingRef.current = false;
      return () => window.clearTimeout(timeout);
    }
    wasStreamingRef.current = streaming;
    return undefined;
  }, [streaming]);

  if (streaming) {
    return (
      <CircleDashed
        data-testid="activity-reasoning-marker"
        data-state="thinking"
        className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/55"
        strokeWidth={1.8}
      />
    );
  }
  return (
    <span
      data-testid="activity-reasoning-marker"
      data-state="done"
      className={cn(
        "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border border-emerald-500/28 text-emerald-500/78",
        justCompleted && "shadow-[0_0_0_3px_rgba(16,185,129,0.10)]",
      )}
    >
      <Check className="h-2.5 w-2.5 stroke-[2.4]" />
    </span>
  );
}
