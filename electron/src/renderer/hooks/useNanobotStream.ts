import { useCallback, useEffect, useRef, useState } from "react";

import { useClient } from "@/providers/ClientProvider";
import { toMediaAttachment } from "@/lib/media";
import {
  mergeToolProgressEvents,
  mergeUniqueToolTraceLines,
  normalizeToolProgressEvents,
  toolTraceLinesFromEvents,
} from "@/lib/tool-traces";
import type { StreamError } from "@/lib/nanobot-client";
import type {
  InboundEvent,
  OutboundCliAppMention,
  OutboundImageGeneration,
  OutboundMcpPresetMention,
  OutboundMedia,
  GoalStateWsPayload,
  UIImage,
  UIFileEdit,
  UIMessage,
} from "@/lib/types";
import {
  allVisionCaptionsDone,
  applyVisionCaptionParts,
  userMessageImageCount,
  type VisionCaptionPart,
} from "@/lib/vision-caption";
import {
  getInboundSourceChannel,
  requestTrayBlinkForInboxEvent,
  requestTrayBlinkForStreamTurnEnd,
} from "@/lib/tray-notify";

interface StreamBuffer {
  /** ID of the assistant message currently receiving deltas (cleared on ``stream_end``). */
  messageId: string;
}

interface ActiveAssistantCursor {
  id: string;
  index: number;
}

type PendingStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string };

type PendingCaptionEvent =
  | { kind: "delta"; index: number; text: string }
  | { kind: "end"; index: number; text?: string; error?: string };

/**
 * 查找仍可接收正文 delta 的 assistant 流。
 *
 * trace 是一次工具调用阶段边界：如果正文已经出现在 trace 后面，它属于工具后的
 * 下一段 assistant 输出，不能再回头认领 trace 前的 reasoning placeholder。
 */
export function findStreamingAssistantIndex(
  prev: UIMessage[],
  closedStreamIds: ReadonlySet<string>,
): number | null {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (m.kind === "trace") break;
    if (m.role === "assistant" && m.isStreaming && !closedStreamIds.has(m.id)) return i;
    if (m.role === "user") break;
  }
  return null;
}

/**
 * Append a reasoning chunk to the last open reasoning stream in ``prev``.
 *
 * Lookup rule: prefer the most recent assistant turn in the active UI tail.
 * Most providers emit reasoning before answer text, but some only expose
 * ``reasoning_content`` after the answer stream completes. In that post-hoc
 * case the reasoning still belongs to the same assistant turn and must render
 * above the answer, not as a new row below it.
 */
function attachReasoningChunk(
  prev: UIMessage[],
  chunk: string,
  segments?: {
    ensure: () => string;
  },
): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    // A user turn is a hard boundary: reasoning after it belongs to the new
    // assistant turn, never to an earlier assistant reply.
    if (candidate.role === "user") break;
    // A trace row (e.g. Used tools) is also a phase boundary. Reasoning after
    // tools belongs to the next assistant iteration, not the assistant turn
    // that produced those tool calls.
    if (candidate.kind === "trace") break;
    if (candidate.role !== "assistant") continue;
    const activitySegmentId = candidate.activitySegmentId ?? segments?.ensure();
    const hasAnswer = candidate.content.length > 0;
    if (
      candidate.reasoningStreaming
      || candidate.reasoning !== undefined
      || hasAnswer
      || candidate.isStreaming
    ) {
      const merged: UIMessage = {
        ...candidate,
        reasoning: (candidate.reasoning ?? "") + chunk,
        reasoningStreaming: true,
        ...(activitySegmentId ? { activitySegmentId } : {}),
      };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
    if (!hasAnswer && candidate.isStreaming) {
      const merged: UIMessage = {
        ...candidate,
        reasoning: chunk,
        reasoningStreaming: true,
        ...(activitySegmentId ? { activitySegmentId } : {}),
      };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
    break;
  }
  const activitySegmentId = segments?.ensure();
  return [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      isStreaming: true,
      reasoning: chunk,
      reasoningStreaming: true,
      ...(activitySegmentId ? { activitySegmentId } : {}),
      createdAt: Date.now(),
    },
  ];
}

/**
 * Find the most recent assistant placeholder that an incoming answer
 * delta should adopt instead of spawning a parallel row. We look for an
 * empty-content assistant turn that is still marked ``isStreaming`` —
 * typically created earlier by ``reasoning_delta``. Anything else means
 * the model already produced an answer in a previous turn, so the new
 * delta belongs in a fresh row.
 */
function findActiveAssistantPlaceholderIndex(prev: UIMessage[]): number | null {
  const last = prev[prev.length - 1];
  if (!last) return null;
  if (last.role !== "assistant" || last.kind === "trace") return null;
  if (last.content.length > 0) return null;
  if (!last.isStreaming) return null;
  return prev.length - 1;
}

function replaceMessageAt(prev: UIMessage[], index: number, message: UIMessage): UIMessage[] {
  const next = prev.slice();
  next[index] = message;
  return next;
}

function findLastUserIndex(prev: UIMessage[]): number {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (prev[i].role === "user") return i;
  }
  return -1;
}

function patchLastUserVisionCaption(
  prev: UIMessage[],
  parts: ReadonlyMap<number, VisionCaptionPart>,
  imageCount: number,
  streaming: boolean,
): UIMessage[] {
  const idx = findLastUserIndex(prev);
  if (idx === -1) return prev;
  const msg = prev[idx];
  const count = imageCount > 0 ? imageCount : userMessageImageCount(msg);
  if (count <= 0) return prev;
  return replaceMessageAt(prev, idx, {
    ...msg,
    content: applyVisionCaptionParts(msg.content, parts, count),
    visionCaptionStreaming: streaming,
  });
}

function finalizeUserVisionCaptionStreaming(prev: UIMessage[]): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const message = prev[i];
    if (message.role !== "user") continue;
    if (!message.visionCaptionStreaming) return prev;
    return replaceMessageAt(prev, i, { ...message, visionCaptionStreaming: false });
  }
  return prev;
}

function applyPendingCaptionEvents(
  prev: UIMessage[],
  events: PendingCaptionEvent[],
  parts: Map<number, VisionCaptionPart>,
  imageCount: number,
): { messages: UIMessage[]; imageCount: number } {
  if (events.length === 0) {
    return { messages: prev, imageCount };
  }

  let maxIndex = -1;
  for (const event of events) {
    maxIndex = Math.max(maxIndex, event.index);
    if (event.kind === "delta") {
      const existing = parts.get(event.index) ?? { text: "", done: false };
      parts.set(event.index, { ...existing, text: existing.text + event.text });
      continue;
    }
    const existing = parts.get(event.index) ?? { text: "", done: false };
    parts.set(event.index, {
      text: existing.text || event.text || "",
      done: true,
      ...(event.error ? { error: event.error } : {}),
    });
  }

  const lastUser = findLastUserIndex(prev);
  if (lastUser === -1) {
    return { messages: prev, imageCount };
  }
  const count = imageCount
    || userMessageImageCount(prev[lastUser])
    || maxIndex + 1;
  const streaming = !allVisionCaptionsDone(parts, count);
  return {
    messages: patchLastUserVisionCaption(prev, parts, count, streaming),
    imageCount: count,
  };
}

/**
 * Close the active reasoning stream segment, if any. Idempotent: a
 * ``reasoning_end`` with no preceding deltas is a harmless no-op.
 */
function closeReasoningStream(prev: UIMessage[]): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    if (!candidate.reasoningStreaming) continue;
    const merged: UIMessage = { ...candidate, reasoningStreaming: false };
    return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
  }
  return prev;
}

function isReasoningOnlyPlaceholder(message: UIMessage): boolean {
  return (
    message.role === "assistant"
    && message.kind !== "trace"
    && message.content.trim().length === 0
    && !!message.reasoning
    && !message.reasoningStreaming
    && !message.media?.length
  );
}

function isToolTrace(message: UIMessage | undefined): boolean {
  return message?.kind === "trace";
}

function isAssistantAnswerMessage(message: UIMessage): boolean {
  return (
    message.role === "assistant"
    && message.kind !== "trace"
    && (message.content.trim().length > 0 || !!message.media?.length)
  );
}

function pruneReasoningOnlyPlaceholders(prev: UIMessage[]): UIMessage[] {
  return prev.filter((message, index) => {
    if (!isReasoningOnlyPlaceholder(message)) return true;
    // A reasoning-only assistant row immediately followed by tool traces is
    // the live equivalent of a persisted assistant tool-call message with
    // empty content, reasoning_content, and tool_calls. Keep it so live render
    // and history replay stay isomorphic.
    return isToolTrace(prev[index + 1]);
  });
}

function stampLastAssistantLatency(prev: UIMessage[], latencyMs: number): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (isAssistantAnswerMessage(m)) {
      const merged: UIMessage = { ...m, latencyMs, isStreaming: false };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

function stampLastAssistantTs(prev: UIMessage[], ts: string | number): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (isAssistantAnswerMessage(m)) {
      const merged: UIMessage = { ...m, messageTs: ts };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

function stampLastAssistantUsage(prev: UIMessage[], usage: UIMessage["usage"]): UIMessage[] {
  if (!usage) return prev;
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (isAssistantAnswerMessage(m)) {
      const merged: UIMessage = { ...m, usage };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

function findLatestAssistantAnswerIndex(prev: UIMessage[]): number | null {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (m.role === "assistant" && m.kind !== "trace") return i;
    if (m.role === "user") break;
  }
  return null;
}

function absorbCompleteAssistantMessage(
  prev: UIMessage[],
  message: Omit<UIMessage, "id" | "role" | "createdAt">,
): UIMessage[] {
  const last = prev[prev.length - 1];
  if (!last || !isReasoningOnlyPlaceholder(last)) {
    return [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        createdAt: Date.now(),
        ...message,
      },
    ];
  }
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      ...message,
      isStreaming: false,
      reasoningStreaming: false,
    },
  ];
}

function fileEditKey(edit: Pick<UIFileEdit, "call_id" | "tool" | "path">): string {
  if (edit.call_id) return `${edit.call_id}|${edit.tool}`;
  return `${edit.tool}|${edit.path}`;
}

function normalizeFileEdit(edit: UIFileEdit): UIFileEdit | null {
  if (!edit || !edit.tool || (!edit.path && !edit.pending)) return null;
  const inferredStatus =
    edit.phase === "error"
      ? "error"
      : edit.phase === "end"
        ? "done"
        : "editing";
  const normalized: UIFileEdit = {
    ...edit,
    call_id: edit.call_id || `${edit.tool}:${edit.path}`,
    added: Number.isFinite(edit.added) ? Math.max(0, Math.round(edit.added)) : 0,
    deleted: Number.isFinite(edit.deleted) ? Math.max(0, Math.round(edit.deleted)) : 0,
    status: edit.status === "error" || edit.status === "done" || edit.status === "editing"
      ? edit.status
      : inferredStatus,
  };
  if (edit.pending && !edit.path) normalized.pending = true;
  return normalized;
}

function mergeFileEdits(existing: UIFileEdit[] | undefined, incoming: UIFileEdit[]): UIFileEdit[] {
  const next = [...(existing ?? [])];
  const indexByKey = new Map(next.map((edit, index) => [fileEditKey(edit), index]));
  for (const raw of incoming) {
    const edit = normalizeFileEdit(raw);
    if (!edit) continue;
    const key = fileEditKey(edit);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, next.length);
      next.push(edit);
      continue;
    }
    const merged = { ...next[existingIndex], ...edit };
    if (edit.path && !edit.pending) delete merged.pending;
    next[existingIndex] = merged;
  }
  return next;
}

function findFileEditTraceIndex(
  prev: UIMessage[],
  segmentId: string | null,
  incoming: UIFileEdit[],
): number | null {
  const incomingKeys = new Set(incoming.map(fileEditKey));
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    if (candidate.role === "user") break;
    if (candidate.kind !== "trace" || !candidate.fileEdits?.length) continue;
    if (segmentId && candidate.activitySegmentId === segmentId) return i;
    for (const existing of candidate.fileEdits) {
      if (incomingKeys.has(fileEditKey(existing))) return i;
    }
  }
  return null;
}

/**
 * Subscribe to a chat by ID. Returns the in-memory message list for the chat,
 * a streaming flag, and a ``send`` function. Initial history must be seeded
 * separately (e.g. via ``fetchWebuiThread``) since the server only replays
 * live events.
 */
/** Payload passed to ``send`` when the user attaches one or more images.
 *
 * ``media`` is handed to the wire client verbatim; ``preview`` powers the
 * optimistic user bubble (blob URLs so the preview appears before the server
 * acks the frame). Keeping the two separate lets the bubble re-use the local
 * blob URL even after the server persists the file under a different name. */
export interface SendImage {
  media: OutboundMedia;
  preview: UIImage;
}

export interface SendOptions {
  imageGeneration?: OutboundImageGeneration;
  cliApps?: OutboundCliAppMention[];
  mcpPresets?: OutboundMcpPresetMention[];
}

export function useNanobotStream(
  chatId: string | null,
  initialMessages: UIMessage[] = [],
  hasPendingToolCalls = false,
  onTurnEnd?: () => void,
  /** 统一收件箱托盘提醒：null = 全部频道，string = 仅该 channel */
  inboxActiveChannel: string | null = null,
): {
  messages: UIMessage[];
  isStreaming: boolean;
  /** Unix epoch seconds when the current user turn started (WebSocket ``goal_status``). */
  runStartedAt: number | null;
  /** Latest sustained goal for this ``chatId`` (``goal_state`` WS events). */
  goalState: GoalStateWsPayload | undefined;
  send: (content: string, images?: SendImage[], options?: SendOptions) => void;
  stop: () => void;
  setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>;
  replaceMessagesFromSnapshot: (nextMessages: UIMessage[]) => void;
  /** Latest transport-level fault raised since the last ``dismissStreamError``.
   * ``null`` when there is nothing to show. */
  streamError: StreamError | null;
  /** Clear the current ``streamError`` (e.g. after the user dismisses the
   * notification or starts a fresh action). */
  dismissStreamError: () => void;
} {
  const { client } = useClient();
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  /** If the last loaded message is a trace row (e.g. "Using 2 tools"),
   * the model was still processing when the page loaded — keep the
   * loading spinner alive so the user sees the model is active. */
  const initialStreaming = initialMessages.length > 0
    ? initialMessages[initialMessages.length - 1].kind === "trace"
    : false;
  const [isStreaming, setIsStreaming] = useState(initialStreaming || hasPendingToolCalls);
  /** Unix epoch seconds when the current user turn started; cleared on ``idle``. */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [goalState, setGoalState] = useState<GoalStateWsPayload | undefined>(undefined);
  const [streamError, setStreamError] = useState<StreamError | null>(null);
  const buffer = useRef<StreamBuffer | null>(null);
  const activeAssistantRef = useRef<ActiveAssistantCursor | null>(null);
  const closedAssistantStreamIdsRef = useRef<Set<string>>(new Set());
  const activitySegmentRef = useRef<string | null>(null);
  const fileEditSegmentRef = useRef<string | null>(null);
  const activitySegmentCounterRef = useRef(0);
  const pendingStreamEventsRef = useRef<PendingStreamEvent[]>([]);
  const streamFrameRef = useRef<number | null>(null);
  const pendingCaptionEventsRef = useRef<PendingCaptionEvent[]>([]);
  const captionFrameRef = useRef<number | null>(null);
  const suppressStreamUntilTurnEndRef = useRef(false);
  /** Timer that defers ``isStreaming = false`` after ``stream_end``.
   *
   * When the model finishes a text segment and calls a tool, the server
   * sends ``stream_end`` but the agent is still "thinking" while the tool
   * executes.  By deferring the flag reset by a short window (1 s) we keep
   * the loading spinner alive across tool-call boundaries without needing
   * backend changes. */
  const streamEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionPartsRef = useRef<Map<number, VisionCaptionPart>>(new Map());
  const captionImageCountRef = useRef(0);
  /** 当前 agent 回合是否收到过 answer delta（供 turn_end 流式补通知）。 */
  const streamTurnHadAssistantDeltaRef = useRef(false);
  /** 当前回合关联的 source_channel（delta 常不带该字段，从 user/message 继承）。 */
  const streamTurnSourceChannelRef = useRef<string | undefined>(undefined);

  const trayNotifyOptions = useRef({ activeChannel: inboxActiveChannel });
  trayNotifyOptions.current = { activeChannel: inboxActiveChannel };

  useEffect(() => {
    return client.onError((err) => setStreamError(err));
  }, [client]);

  const dismissStreamError = useCallback(() => setStreamError(null), []);

  const clearPendingStreamWork = useCallback(() => {
    if (streamFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    pendingStreamEventsRef.current = [];
    if (captionFrameRef.current !== null) {
      window.cancelAnimationFrame(captionFrameRef.current);
      captionFrameRef.current = null;
    }
    pendingCaptionEventsRef.current = [];
  }, []);

  const createActivitySegmentId = useCallback((activate = true) => {
    activitySegmentCounterRef.current += 1;
    const id = `activity-${activitySegmentCounterRef.current}`;
    if (activate) activitySegmentRef.current = id;
    return id;
  }, []);

  const freshActivitySegmentId = useCallback(
    () => createActivitySegmentId(true),
    [createActivitySegmentId],
  );

  const detachedActivitySegmentId = useCallback(
    () => createActivitySegmentId(false),
    [createActivitySegmentId],
  );

  const ensureActivitySegmentId = useCallback(() => {
    if (activitySegmentRef.current) return activitySegmentRef.current;
    return freshActivitySegmentId();
  }, [freshActivitySegmentId]);

  const clearActivitySegment = useCallback(() => {
    activitySegmentRef.current = null;
    fileEditSegmentRef.current = null;
  }, []);

  const closeActiveAssistantStream = useCallback(() => {
    const closedStreamId = buffer.current?.messageId ?? activeAssistantRef.current?.id;
    if (closedStreamId) closedAssistantStreamIdsRef.current.add(closedStreamId);
    buffer.current = null;
    activeAssistantRef.current = null;
  }, []);

  const resolveActiveAssistantIndex = useCallback((prev: UIMessage[]): number | null => {
    const cursor = activeAssistantRef.current;
    if (!cursor) return null;
    const indexed = prev[cursor.index];
    if (indexed?.id === cursor.id && indexed.role === "assistant" && indexed.kind !== "trace") {
      return cursor.index;
    }
    const idx = prev.findIndex((m) => m.id === cursor.id);
    if (idx === -1) {
      activeAssistantRef.current = null;
      return null;
    }
    const found = prev[idx];
    if (found.role !== "assistant" || found.kind === "trace") {
      activeAssistantRef.current = null;
      return null;
    }
    activeAssistantRef.current = { id: cursor.id, index: idx };
    return idx;
  }, []);

  const appendAnswerChunk = useCallback(
    (prev: UIMessage[], chunk: string): UIMessage[] => {
      let next = prev;
      let targetIndex = resolveActiveAssistantIndex(next);

      if (targetIndex === null) {
        targetIndex = findActiveAssistantPlaceholderIndex(next);
      }
      if (targetIndex === null) {
        targetIndex = findStreamingAssistantIndex(next, closedAssistantStreamIdsRef.current);
      }
      if (targetIndex === null) {
        const id = crypto.randomUUID();
        next = [
          ...next,
          {
            id,
            role: "assistant",
            content: "",
            isStreaming: true,
            createdAt: Date.now(),
          },
        ];
        targetIndex = next.length - 1;
      }

      const target = next[targetIndex];
      const merged: UIMessage = {
        ...target,
        content: target.content + chunk,
        isStreaming: true,
      };
      closedAssistantStreamIdsRef.current.delete(merged.id);
      activeAssistantRef.current = { id: merged.id, index: targetIndex };
      buffer.current = { messageId: merged.id };
      return replaceMessageAt(next, targetIndex, merged);
    },
    [resolveActiveAssistantIndex],
  );

  const applyPendingStreamEvents = useCallback(
    (prev: UIMessage[], events: PendingStreamEvent[]): UIMessage[] => {
      let next = prev;
      for (let i = 0; i < events.length;) {
        const kind = events[i].kind;
        let text = "";
        while (i < events.length && events[i].kind === kind) {
          text += events[i].text;
          i += 1;
        }
        next = kind === "delta"
          ? appendAnswerChunk(next, text)
          : attachReasoningChunk(next, text, {
              ensure: ensureActivitySegmentId,
            });
      }
      return next;
    },
    [appendAnswerChunk, ensureActivitySegmentId],
  );

  const flushPendingStreamEvents = useCallback((options?: {
    closeAnswerSegment?: boolean;
    finalAnswerText?: string;
  }) => {
    if (streamFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    const events = pendingStreamEventsRef.current;
    const finalAnswerText = options?.finalAnswerText;
    if (events.length === 0 && finalAnswerText === undefined) {
      if (options?.closeAnswerSegment) closeActiveAssistantStream();
      return;
    }
    pendingStreamEventsRef.current = [];
    setMessages((prev) => {
      let next = events.length > 0 ? applyPendingStreamEvents(prev, events) : prev;
      if (finalAnswerText !== undefined) {
        const targetIndex =
          resolveActiveAssistantIndex(next)
          ?? findStreamingAssistantIndex(next, closedAssistantStreamIdsRef.current)
          ?? findLatestAssistantAnswerIndex(next);
          if (targetIndex !== null) {
            const target = next[targetIndex];
            next = replaceMessageAt(next, targetIndex, {
              ...target,
              content: finalAnswerText,
              isStreaming: true,
            });
          } else {
            const id = crypto.randomUUID();
            closedAssistantStreamIdsRef.current.add(id);
            next = [
              ...next,
              {
                id,
                role: "assistant",
                content: finalAnswerText,
                isStreaming: true,
                createdAt: Date.now(),
              },
            ];
          }
        }
      if (options?.closeAnswerSegment) closeActiveAssistantStream();
      return next;
    });
  }, [applyPendingStreamEvents, closeActiveAssistantStream, resolveActiveAssistantIndex]);

  const schedulePendingStreamFlush = useCallback(() => {
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = window.requestAnimationFrame(() => {
      streamFrameRef.current = null;
      const events = pendingStreamEventsRef.current;
      if (events.length === 0) return;
      pendingStreamEventsRef.current = [];
      setMessages((prev) => applyPendingStreamEvents(prev, events));
    });
  }, [applyPendingStreamEvents]);

  const mergePendingCaptionEvents = useCallback((prev: UIMessage[], events: PendingCaptionEvent[]) => {
    const nextParts = new Map(captionPartsRef.current);
    const merged = applyPendingCaptionEvents(
      prev,
      events,
      nextParts,
      captionImageCountRef.current,
    );
    captionPartsRef.current = nextParts;
    if (merged.imageCount > 0) {
      captionImageCountRef.current = merged.imageCount;
    }
    return merged.messages;
  }, []);

  const flushPendingCaptionEvents = useCallback(() => {
    if (captionFrameRef.current !== null) {
      window.cancelAnimationFrame(captionFrameRef.current);
      captionFrameRef.current = null;
    }
    const events = pendingCaptionEventsRef.current;
    if (events.length === 0) return;
    pendingCaptionEventsRef.current = [];
    setMessages((prev) => mergePendingCaptionEvents(prev, events));
  }, [mergePendingCaptionEvents]);

  const schedulePendingCaptionFlush = useCallback(() => {
    if (captionFrameRef.current !== null) return;
    captionFrameRef.current = window.requestAnimationFrame(() => {
      captionFrameRef.current = null;
      const events = pendingCaptionEventsRef.current;
      if (events.length === 0) return;
      pendingCaptionEventsRef.current = [];
      setMessages((prev) => mergePendingCaptionEvents(prev, events));
    });
  }, [mergePendingCaptionEvents]);

  const replaceMessagesFromSnapshot = useCallback((nextMessages: UIMessage[]) => {
    const snapshotIsStreaming = nextMessages.length > 0
      ? nextMessages[nextMessages.length - 1].kind === "trace"
      : false;

    setMessages(nextMessages);
    setIsStreaming(snapshotIsStreaming || hasPendingToolCalls);
    setRunStartedAt(chatId ? client.getRunStartedAt(chatId) : null);
    setGoalState(chatId ? client.getGoalState(chatId) : undefined);
    buffer.current = null;
    activeAssistantRef.current = null;
    closedAssistantStreamIdsRef.current.clear();
    clearActivitySegment();
    clearPendingStreamWork();
    suppressStreamUntilTurnEndRef.current = false;
    if (streamEndTimerRef.current !== null) {
      clearTimeout(streamEndTimerRef.current);
      streamEndTimerRef.current = null;
    }
  }, [chatId, clearActivitySegment, clearPendingStreamWork, client, hasPendingToolCalls]);

  // Reset local state when switching chats. Do not reset on every
  // ``initialMessages`` update: a brand-new chat can receive an empty/404
  // history response after the optimistic first message has already rendered.
  useEffect(() => {
    setMessages(initialMessages);
    setIsStreaming(
      (initialMessages.length > 0
        ? initialMessages[initialMessages.length - 1].kind === "trace"
        : false) || hasPendingToolCalls,
    );
    setStreamError(null);
    setRunStartedAt(chatId ? client.getRunStartedAt(chatId) : null);
    setGoalState(chatId ? client.getGoalState(chatId) : undefined);
    buffer.current = null;
    activeAssistantRef.current = null;
    closedAssistantStreamIdsRef.current.clear();
    clearActivitySegment();
    clearPendingStreamWork();
    suppressStreamUntilTurnEndRef.current = false;
    if (streamEndTimerRef.current !== null) {
      clearTimeout(streamEndTimerRef.current);
      streamEndTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, client, clearActivitySegment, clearPendingStreamWork]);

  useEffect(() => {
    if (hasPendingToolCalls) setIsStreaming(true);
  }, [hasPendingToolCalls]);

  useEffect(() => {
    if (!chatId) return;

    const handle = (ev: InboundEvent) => {
      // Any incoming event while the debounce timer is alive means the model
      // is still working (e.g. tool result arrived, more text to stream).
      // Cancel the pending "stream ended" timer so we don't hide the spinner.
      if (streamEndTimerRef.current !== null) {
        clearTimeout(streamEndTimerRef.current);
        streamEndTimerRef.current = null;
      }

      if (ev.event === "delta") {
        if (suppressStreamUntilTurnEndRef.current) return;
        const chunk = typeof ev.text === "string" ? ev.text : "";
        if (!chunk) return;
        streamTurnHadAssistantDeltaRef.current = true;
        const deltaSource = getInboundSourceChannel(ev);
        if (deltaSource) streamTurnSourceChannelRef.current = deltaSource;
        clearActivitySegment();
        setIsStreaming(true);
        pendingStreamEventsRef.current.push({ kind: "delta", text: chunk });
        schedulePendingStreamFlush();
        return;
      }

      if (ev.event === "reasoning_delta") {
        if (suppressStreamUntilTurnEndRef.current) return;
        const chunk = ev.text;
        if (!chunk) return;
        if (fileEditSegmentRef.current) clearActivitySegment();
        setIsStreaming(true);
        pendingStreamEventsRef.current.push({ kind: "reasoning", text: chunk });
        schedulePendingStreamFlush();
        return;
      }

      if (ev.event === "vision_caption_delta") {
        const chunk = ev.text;
        if (!chunk) return;
        const index = typeof ev.image_index === "number" ? ev.image_index : 0;
        setIsStreaming(true);
        pendingCaptionEventsRef.current.push({ kind: "delta", index, text: chunk });
        schedulePendingCaptionFlush();
        return;
      }

      if (ev.event === "vision_caption_end") {
        const index = typeof ev.image_index === "number" ? ev.image_index : 0;
        pendingCaptionEventsRef.current.push({
          kind: "end",
          index,
          ...(typeof ev.text === "string" && ev.text ? { text: ev.text } : {}),
          ...(typeof ev.error === "string" && ev.error ? { error: ev.error } : {}),
        });
        // end 立即 flush，确保 caption 折叠标题从「识别中」切到「识别结果」
        flushPendingCaptionEvents();
        return;
      }

      if (ev.event === "stream_end") {
        flushPendingStreamEvents({
          closeAnswerSegment: true,
          ...(typeof ev.text === "string" ? { finalAnswerText: ev.text } : {}),
        });
        if (suppressStreamUntilTurnEndRef.current) return;
        // stream_end only means the text segment finished — the model may
        // still be executing tools.  Do NOT reset isStreaming here; the
        // definitive "turn is complete" signal is ``turn_end``.
        return;
      }

      flushPendingStreamEvents();

      if (ev.event === "reasoning_end") {
        if (suppressStreamUntilTurnEndRef.current) return;
        setMessages((prev) => closeReasoningStream(prev));
        return;
      }

      if (ev.event === "goal_state") {
        setGoalState(ev.goal_state);
        return;
      }

      if (ev.event === "goal_status") {
        if (ev.status === "running" && typeof ev.started_at === "number") {
          setRunStartedAt(ev.started_at);
        } else {
          setRunStartedAt(null);
        }
        return;
      }

      if (ev.event === "turn_end") {
        if ("goal_state" in ev && ev.goal_state != null && typeof ev.goal_state === "object") {
          setGoalState(ev.goal_state);
        }
        flushPendingStreamEvents();
        if (captionFrameRef.current !== null) {
          window.cancelAnimationFrame(captionFrameRef.current);
          captionFrameRef.current = null;
        }
        const pendingCaptionEvents = pendingCaptionEventsRef.current;
        pendingCaptionEventsRef.current = [];
        // Definitive signal that the turn is fully complete.  Cancel any
        // pending debounce timer and stop the loading indicator immediately.
        if (streamEndTimerRef.current !== null) {
          clearTimeout(streamEndTimerRef.current);
          streamEndTimerRef.current = null;
        }
        setIsStreaming(false);
        setRunStartedAt(null);
        setMessages((prev) => {
          let finalized = pendingCaptionEvents.length > 0
            ? mergePendingCaptionEvents(prev, pendingCaptionEvents)
            : prev;
          finalized = finalized.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
          finalized = pruneReasoningOnlyPlaceholders(finalized);
          finalized = finalizeUserVisionCaptionStreaming(finalized);
          if (typeof ev.latency_ms === "number" && ev.latency_ms >= 0) {
            finalized = stampLastAssistantLatency(finalized, Math.round(ev.latency_ms));
          }
          if (ev.usage && typeof ev.usage === "object") {
            finalized = stampLastAssistantUsage(finalized, ev.usage);
          }
          finalized = stampLastAssistantTs(finalized, Date.now());
          buffer.current = null;
          activeAssistantRef.current = null;
          clearActivitySegment();
          closedAssistantStreamIdsRef.current.clear();
          return finalized;
        });
        suppressStreamUntilTurnEndRef.current = false;
        captionPartsRef.current = new Map();
        captionImageCountRef.current = 0;
        requestTrayBlinkForStreamTurnEnd(
          chatId,
          streamTurnHadAssistantDeltaRef.current,
          streamTurnSourceChannelRef.current,
          trayNotifyOptions.current,
        );
        streamTurnHadAssistantDeltaRef.current = false;
        streamTurnSourceChannelRef.current = undefined;
        onTurnEnd?.();
        return;
      }

      if (ev.event === "user") {
        const content = typeof ev.text === "string" ? ev.text : "";
        const media = ev.media_urls?.length
          ? ev.media_urls.map((m) => toMediaAttachment(m))
          : undefined;
        if (!content.trim() && !media) return;

        // 外部 channel 带图入站：重置 caption 累积器，供后续 vision_caption_* 事件使用。
        const mediaCount = media?.length ?? 0;
        if (mediaCount > 0 && ev.source_channel) {
          captionPartsRef.current = new Map();
          captionImageCountRef.current = mediaCount;
        }
        if (ev.source_channel) {
          streamTurnSourceChannelRef.current = ev.source_channel;
        }

        // 外部 channel 推来的用户消息：仅追加，不干扰本地正在进行的流式状态。
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "user" as const,
            content,
            createdAt: Date.now(),
            ...(media ? { media } : {}),
            ...(ev.source_channel ? { sourceChannel: ev.source_channel } : {}),
          },
        ]);
        requestTrayBlinkForInboxEvent(chatId, ev, trayNotifyOptions.current);
        return;
      }

      if (ev.event === "message") {
        if (
          suppressStreamUntilTurnEndRef.current &&
          (ev.kind === "tool_hint" || ev.kind === "progress" || ev.kind === "reasoning")
        ) {
          return;
        }
        // Back-compat: a legacy ``kind: "reasoning"`` message (no streaming
        // partner) is treated as one complete delta + immediate end so the
        // bubble renders identically to the streaming path.
        if (ev.kind === "reasoning") {
          const line = ev.text;
          if (!line) return;
          if (fileEditSegmentRef.current) clearActivitySegment();
          setMessages((prev) => closeReasoningStream(attachReasoningChunk(prev, line, {
            ensure: ensureActivitySegmentId,
          })));
          return;
        }
        // Intermediate agent breadcrumbs (tool-call hints, raw progress).
        // Attach them to the last trace row if it was the last emitted item
        // so a sequence of calls collapses into one compact trace group.
        if (ev.kind === "tool_hint" || ev.kind === "progress") {
          const structuredEvents = normalizeToolProgressEvents(ev.tool_events);
          const structuredLines = toolTraceLinesFromEvents(ev.tool_events);
          const lines = structuredLines.length > 0
            ? structuredLines
            : ev.text
              ? [ev.text]
              : [];
          if (lines.length === 0) return;
          setMessages((prev) => {
            const segmentId = ensureActivitySegmentId();
            const last = prev[prev.length - 1];
            if (
              last
              && last.kind === "trace"
              && !last.isStreaming
              && (!last.activitySegmentId || last.activitySegmentId === segmentId)
            ) {
              const previousTraces = last.traces?.length
                ? last.traces
                : last.content
                  ? [last.content]
                  : [];
              const mergedLines = structuredLines.length > 0
                ? mergeUniqueToolTraceLines(previousTraces, structuredLines)
                : null;
              const merged: UIMessage = {
                ...last,
                traces: mergedLines ? mergedLines.traces : [...previousTraces, ...lines],
                content: mergedLines
                  ? mergedLines.traces[mergedLines.traces.length - 1]
                  : lines[lines.length - 1],
                toolEvents: structuredEvents.length
                  ? mergeToolProgressEvents(last.toolEvents, structuredEvents)
                  : last.toolEvents,
                activitySegmentId: last.activitySegmentId ?? segmentId,
              };
              return [...prev.slice(0, -1), merged];
            }
            return [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "tool",
                kind: "trace",
                content: lines[lines.length - 1],
                traces: lines,
                ...(structuredEvents.length ? { toolEvents: structuredEvents } : {}),
                activitySegmentId: segmentId,
                createdAt: Date.now(),
              },
            ];
          });
          return;
        }

        const media = ev.media_urls?.length
          ? ev.media_urls.map((m) => toMediaAttachment(m))
          : ev.media?.map((url) => toMediaAttachment({ url }));
        const hasMedia = !!media && media.length > 0;

        // A complete (non-streamed) assistant message. If a stream was in
        // flight, drop the placeholder so we don't render the text twice.
        // Do NOT reset isStreaming here — only ``turn_end`` signals that
        // the full turn (all tool calls + final text) is complete.
        clearActivitySegment();
        setMessages((prev) => {
          const activeId = buffer.current?.messageId;
          buffer.current = null;
          activeAssistantRef.current = null;
          const filtered = activeId ? prev.filter((m) => m.id !== activeId) : prev;
          const content = ev.text;
          const lat =
            typeof ev.latency_ms === "number" && ev.latency_ms >= 0
              ? Math.round(ev.latency_ms)
              : undefined;
          return absorbCompleteAssistantMessage(filtered, {
            content,
            ...(hasMedia ? { media } : {}),
            ...(lat !== undefined ? { latencyMs: lat } : {}),
            ...(ev.source_channel ? { sourceChannel: ev.source_channel } : {}),
            ...(ev.channel_delivery ? { channelDelivery: true } : {}),
            ...(ev.user_initiated_delivery ? { userInitiatedDelivery: true } : {}),
            ...(ev.cron_job_id ? { cronJobId: ev.cron_job_id } : {}),
            ...(ev.cron_job_name ? { cronJobName: ev.cron_job_name } : {}),
          });
        });
        if (hasMedia) {
          suppressStreamUntilTurnEndRef.current = true;
        }
        const messageSource = getInboundSourceChannel(ev);
        if (messageSource) streamTurnSourceChannelRef.current = messageSource;
        streamTurnHadAssistantDeltaRef.current = false;
        requestTrayBlinkForInboxEvent(chatId, ev, trayNotifyOptions.current);
        return;
      }
      if (ev.event === "file_edit") {
        const edits = Array.isArray(ev.edits) ? ev.edits : [];
        if (edits.length === 0) return;
        const normalized = mergeFileEdits(undefined, edits);
        if (normalized.length === 0) return;
        const opensFileEditPhase = normalized.some(
          (edit) => edit.status === "editing" || edit.phase === "start",
        );
        let eventSegmentId = fileEditSegmentRef.current;
        if (!eventSegmentId && opensFileEditPhase) {
          eventSegmentId = detachedActivitySegmentId();
          fileEditSegmentRef.current = eventSegmentId;
        }
        setMessages((prev) => {
          let segmentId = eventSegmentId;
          const targetIndex = findFileEditTraceIndex(prev, segmentId, normalized);
          if (targetIndex !== null) {
            const target = prev[targetIndex];
            segmentId = target.activitySegmentId ?? segmentId ?? detachedActivitySegmentId();
            if (opensFileEditPhase) fileEditSegmentRef.current = segmentId;
            const merged: UIMessage = {
              ...target,
              fileEdits: mergeFileEdits(target.fileEdits, normalized),
              activitySegmentId: segmentId,
            };
            return replaceMessageAt(prev, targetIndex, merged);
          }
          segmentId = segmentId ?? detachedActivitySegmentId();
          if (opensFileEditPhase) fileEditSegmentRef.current = segmentId;
          return [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              fileEdits: normalized,
              activitySegmentId: segmentId,
              createdAt: Date.now(),
            },
          ];
        });
        return;
      }
      // ``attached`` / ``error`` frames aren't actionable here; the client
      // shell handles them separately.
    };

    const unsub = client.onChat(chatId, handle);
    return () => {
      unsub();
      buffer.current = null;
      activeAssistantRef.current = null;
      closedAssistantStreamIdsRef.current.clear();
      clearActivitySegment();
      clearPendingStreamWork();
      if (streamEndTimerRef.current !== null) {
        clearTimeout(streamEndTimerRef.current);
        streamEndTimerRef.current = null;
      }
    };
  }, [
    chatId,
    client,
    clearActivitySegment,
    clearPendingStreamWork,
    detachedActivitySegmentId,
    ensureActivitySegmentId,
    flushPendingStreamEvents,
    flushPendingCaptionEvents,
    mergePendingCaptionEvents,
    onTurnEnd,
    schedulePendingCaptionFlush,
    schedulePendingStreamFlush,
  ]);

  const send = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      if (!chatId) return;
      const hasImages = !!images && images.length > 0;
      // Text is optional when images are attached — the agent will still see
      // the image blocks via ``media`` paths.
      if (!hasImages && !content.trim()) return;

      streamTurnHadAssistantDeltaRef.current = false;
      streamTurnSourceChannelRef.current = undefined;

      flushPendingStreamEvents();
      flushPendingCaptionEvents();
      captionPartsRef.current = new Map();
      captionImageCountRef.current = hasImages ? images!.length : 0;
      const previews = hasImages ? images!.map((i) => i.preview) : undefined;
      setMessages((prev) => {
        buffer.current = null;
        activeAssistantRef.current = null;
        closedAssistantStreamIdsRef.current.clear();
        clearActivitySegment();
        return [
          ...pruneReasoningOnlyPlaceholders(prev),
          {
            id: crypto.randomUUID(),
            role: "user",
            content,
            createdAt: Date.now(),
            ...(previews ? { images: previews } : {}),
            ...(options?.cliApps?.length ? { cliApps: options.cliApps } : {}),
            ...(options?.mcpPresets?.length ? { mcpPresets: options.mcpPresets } : {}),
          },
        ];
      });
      // Mark streaming immediately so the UI shows the loading indicator
      // right away, before the first delta arrives from the server.
      setIsStreaming(true);
      const wireMedia = hasImages ? images!.map((i) => i.media) : undefined;
      if (options) {
        client.sendMessage(chatId, content, wireMedia, options);
      } else {
        client.sendMessage(chatId, content, wireMedia);
      }
    },
    [chatId, clearActivitySegment, client, flushPendingStreamEvents],
  );

  const stop = useCallback(() => {
    if (!chatId) return;
    flushPendingStreamEvents();
    setIsStreaming(false);
    setMessages((prev) => {
      buffer.current = null;
      activeAssistantRef.current = null;
      closedAssistantStreamIdsRef.current.clear();
      clearActivitySegment();
      return prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
    });
    suppressStreamUntilTurnEndRef.current = false;
    client.sendMessage(chatId, "/stop");
  }, [chatId, clearActivitySegment, client, flushPendingStreamEvents]);

  return {
    messages,
    isStreaming,
    runStartedAt,
    goalState,
    send,
    stop,
    setMessages,
    replaceMessagesFromSnapshot,
    streamError,
    dismissStreamError,
  };
}
