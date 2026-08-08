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
import {
  appendAssistantAudioChunk,
  enqueueAssistantPlaybackSegment,
  failAssistantAudioStream,
  finishAssistantAudioStream,
  startAssistantAudioStream,
  stopAssistantPlayback,
} from "@/lib/playback-queue";
import type {
  AssistantPlaybackSegment,
  AssistantSpeech,
  InboundEvent,
  OutboundCliAppMention,
  OutboundImageGeneration,
  OutboundMcpPresetMention,
  OutboundMedia,
  GoalStateWsPayload,
  UIImage,
  UIFileEdit,
  UIMessage,
  UITurnPhase,
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
import { appendNotificationPreview } from "../../notification-text";

interface StreamBuffer {
  /** ID of the assistant message currently receiving deltas (cleared on ``stream_end``). */
  messageId: string;
  turnId: string;
}

interface ActiveAssistantCursor {
  id: string;
  index: number;
  turnId: string;
}

interface TurnNotificationPreview {
  text: string;
  segmentEnded: boolean;
  hasMedia?: boolean;
}

type UIMessageTurnFields = Required<Pick<UIMessage, "turnId" | "turnPhase">>
  & Pick<UIMessage, "turnSeq">;

type PendingStreamEvent =
  | {
      kind: "delta";
      text: string;
      streamId?: string;
      sourceChannel?: string;
      turn: UIMessageTurnFields;
    }
  | { kind: "reasoning"; text: string; turn: UIMessageTurnFields };

type PendingCaptionEvent =
  | { kind: "delta"; index: number; text: string }
  | { kind: "end"; index: number; text?: string; error?: string };

function turnFieldsFromEvent(
  ev: Pick<InboundEvent, "turn_id" | "turn_phase" | "turn_seq">,
  fallbackPhase: UITurnPhase,
): UIMessageTurnFields | null {
  if (typeof ev.turn_id !== "string" || !ev.turn_id) return null;
  return {
    turnId: ev.turn_id,
    turnPhase: ev.turn_phase ?? fallbackPhase,
    ...(typeof ev.turn_seq === "number" && Number.isFinite(ev.turn_seq)
      ? { turnSeq: ev.turn_seq }
      : {}),
  };
}

function matchesTurn(message: UIMessage, turn: Pick<UIMessageTurnFields, "turnId">): boolean {
  return message.turnId === turn.turnId;
}

function findSpeechTargetIndex(messages: UIMessage[], turnId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "assistant"
      && message.kind !== "trace"
      && message.turnId === turnId
      && !!message.content.trim()
    ) return index;
  }
  return -1;
}

/**
 * 查找仍可接收正文 delta 的 assistant 流。
 *
 * trace 是一次工具调用阶段边界：如果正文已经出现在 trace 后面，它属于工具后的
 * 下一段 assistant 输出，不能再回头认领 trace 前的 reasoning placeholder。
 */
export function findStreamingAssistantIndex(
  prev: UIMessage[],
  closedStreamIds: ReadonlySet<string>,
  turn: Pick<UIMessageTurnFields, "turnId">,
): number | null {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (!matchesTurn(m, turn)) continue;
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
  turn: UIMessageTurnFields,
  segments?: {
    ensure: () => string;
  },
): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    // A user turn is a hard boundary: reasoning after it belongs to the new
    // assistant turn, never to an earlier assistant reply.
    if (!matchesTurn(candidate, turn)) continue;
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
        ...turn,
      };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
    if (!hasAnswer && candidate.isStreaming) {
      const merged: UIMessage = {
        ...candidate,
        reasoning: chunk,
        reasoningStreaming: true,
        ...(activitySegmentId ? { activitySegmentId } : {}),
        ...turn,
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
      ...turn,
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
function findActiveAssistantPlaceholderIndex(
  prev: UIMessage[],
  turn: Pick<UIMessageTurnFields, "turnId">,
): number | null {
  for (let index = prev.length - 1; index >= 0; index -= 1) {
    const candidate = prev[index];
    if (!matchesTurn(candidate, turn)) continue;
    if (candidate.role !== "assistant" || candidate.kind === "trace") return null;
    if (candidate.content.length > 0 || !candidate.isStreaming) return null;
    return index;
  }
  return null;
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
function closeReasoningStreamForTurn(prev: UIMessage[], turnId: string): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    if (candidate.turnId !== turnId || !candidate.reasoningStreaming) continue;
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

function pruneReasoningOnlyPlaceholders(
  prev: UIMessage[],
  turnId?: string,
): UIMessage[] {
  return prev.filter((message, index) => {
    if (turnId && message.turnId !== turnId) return true;
    if (!isReasoningOnlyPlaceholder(message)) return true;
    // A reasoning-only assistant row immediately followed by tool traces is
    // the live equivalent of a persisted assistant tool-call message with
    // empty content, reasoning_content, and tool_calls. Keep it so live render
    // and history replay stay isomorphic.
    return isToolTrace(prev[index + 1]) && prev[index + 1]?.turnId === message.turnId;
  });
}

function stampLastAssistantLatency(
  prev: UIMessage[],
  latencyMs: number,
  turnId: string,
): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (isAssistantAnswerMessage(m) && m.turnId === turnId) {
      const merged: UIMessage = { ...m, latencyMs, isStreaming: false };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

function stampLastAssistantTs(
  prev: UIMessage[],
  ts: string | number,
  turnId: string,
): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (isAssistantAnswerMessage(m) && m.turnId === turnId) {
      const merged: UIMessage = { ...m, messageTs: ts };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

function stampLastAssistantUsage(
  prev: UIMessage[],
  usage: UIMessage["usage"],
  turnId: string,
): UIMessage[] {
  if (!usage) return prev;
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (isAssistantAnswerMessage(m) && m.turnId === turnId) {
      const merged: UIMessage = { ...m, usage };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

function stampLastAssistantResponseModel(
  prev: UIMessage[],
  event: {
    response_model?: string;
    response_provider?: string;
    fallback_used?: boolean;
    fallback_models?: UIMessage["fallbackModels"];
  },
  turnId: string,
): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const message = prev[i];
    if (isAssistantAnswerMessage(message) && message.turnId === turnId) {
      const merged: UIMessage = {
        ...message,
        ...(event.response_model ? { responseModel: event.response_model } : {}),
        ...(event.response_provider ? { responseProvider: event.response_provider } : {}),
        ...(typeof event.fallback_used === "boolean"
          ? { fallbackUsed: event.fallback_used }
          : {}),
        ...(event.fallback_models?.length
          ? { fallbackModels: event.fallback_models }
          : {}),
      };
      return [...prev.slice(0, i), merged, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

function findLatestAssistantAnswerIndex(
  prev: UIMessage[],
  turn: Pick<UIMessageTurnFields, "turnId">,
): number | null {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (!matchesTurn(m, turn)) continue;
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
  if (
    !last
    || !isReasoningOnlyPlaceholder(last)
    || !message.turnId
    || last.turnId !== message.turnId
  ) {
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
  if (edit.call_id) return `${edit.call_id}|${edit.tool}|${edit.path}`;
  return `${edit.tool}|${edit.path}`;
}

function fileEditToolKey(edit: Pick<UIFileEdit, "call_id" | "tool">): string {
  return `${edit.call_id}|${edit.tool}`;
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

export function mergeFileEdits(
  existing: UIFileEdit[] | undefined,
  incoming: UIFileEdit[],
): UIFileEdit[] {
  const next = [...(existing ?? [])];
  const indexByKey = new Map(next.map((edit, index) => [fileEditKey(edit), index]));
  for (const raw of incoming) {
    const edit = normalizeFileEdit(raw);
    if (!edit) continue;
    const key = fileEditKey(edit);
    let existingIndex = indexByKey.get(key);
    if (existingIndex === undefined && edit.path) {
      const pendingIndex = next.findIndex(
        (candidate) => !candidate.path
          && !!candidate.pending
          && fileEditToolKey(candidate) === fileEditToolKey(edit),
      );
      if (pendingIndex >= 0) existingIndex = pendingIndex;
    }
    if (existingIndex === undefined) {
      indexByKey.set(key, next.length);
      next.push(edit);
      continue;
    }
    const previousKey = fileEditKey(next[existingIndex]);
    const merged = { ...next[existingIndex], ...edit };
    if (edit.path && !edit.pending) delete merged.pending;
    next[existingIndex] = merged;
    if (previousKey !== key) indexByKey.delete(previousKey);
    indexByKey.set(key, existingIndex);
  }
  return next;
}

function findFileEditTraceIndex(
  prev: UIMessage[],
  segmentId: string | null,
  incoming: UIFileEdit[],
  turn: Pick<UIMessageTurnFields, "turnId">,
): number | null {
  const incomingKeys = new Set(incoming.map(fileEditKey));
  const incomingToolKeys = new Set(incoming.map(fileEditToolKey));
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    if (!matchesTurn(candidate, turn)) continue;
    if (candidate.role === "user") break;
    if (candidate.kind !== "trace" || !candidate.fileEdits?.length) continue;
    if (segmentId && candidate.activitySegmentId === segmentId) return i;
    for (const existing of candidate.fileEdits) {
      if (
        incomingKeys.has(fileEditKey(existing))
        || incomingToolKeys.has(fileEditToolKey(existing))
      ) return i;
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
  /** 当前 turn 实际启用的 fallback 模型；turn 完成后清空。 */
  turnModelName: string | null;
  turnModelProvider: string | null;
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
  const [turnModelName, setTurnModelName] = useState<string | null>(null);
  const [turnModelProvider, setTurnModelProvider] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<StreamError | null>(null);
  const buffer = useRef<StreamBuffer | null>(null);
  const activeAssistantRef = useRef<ActiveAssistantCursor | null>(null);
  const closedAssistantStreamIdsRef = useRef<Set<string>>(new Set());
  const closedTurnIdsRef = useRef<Set<string>>(new Set());
  const activeTurnIdsRef = useRef<Set<string>>(new Set());
  const activitySegmentRef = useRef<string | null>(null);
  const activityTurnIdRef = useRef<string | null>(null);
  const fileEditSegmentRef = useRef<string | null>(null);
  const fileEditTurnIdRef = useRef<string | null>(null);
  const activitySegmentCounterRef = useRef(0);
  const pendingStreamEventsRef = useRef<PendingStreamEvent[]>([]);
  const streamFrameRef = useRef<number | null>(null);
  const pendingCaptionEventsRef = useRef<PendingCaptionEvent[]>([]);
  const pendingSpeechRef = useRef<Map<string, AssistantSpeech>>(new Map());
  const captionFrameRef = useRef<number | null>(null);
  const suppressedTurnIdsRef = useRef<Set<string>>(new Set());
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
  /** 收到过 answer delta 的 turn（供 turn_end 流式补通知）。 */
  const streamedTurnIdsRef = useRef<Set<string>>(new Set());
  /** 各 turn 关联的 source_channel（delta 常不带该字段，从 user/message 继承）。 */
  const turnSourceChannelsRef = useRef<Map<string, string>>(new Map());
  /** 各 turn 最后一段 assistant 正文摘要，供 turn_end 系统通知。 */
  const turnNotificationTextRef = useRef<Map<string, TurnNotificationPreview>>(new Map());
  const onTurnEndRef = useRef(onTurnEnd);
  onTurnEndRef.current = onTurnEnd;
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

  const createActivitySegmentId = useCallback((turnId: string, activate = true) => {
    activitySegmentCounterRef.current += 1;
    const id = `activity-${activitySegmentCounterRef.current}`;
    if (activate) {
      activitySegmentRef.current = id;
      activityTurnIdRef.current = turnId;
    }
    return id;
  }, []);

  const freshActivitySegmentId = useCallback(
    (turnId: string) => createActivitySegmentId(turnId, true),
    [createActivitySegmentId],
  );

  const detachedActivitySegmentId = useCallback(
    (turnId: string) => createActivitySegmentId(turnId, false),
    [createActivitySegmentId],
  );

  const ensureActivitySegmentId = useCallback((turnId: string) => {
    if (activitySegmentRef.current && activityTurnIdRef.current === turnId) {
      return activitySegmentRef.current;
    }
    return freshActivitySegmentId(turnId);
  }, [freshActivitySegmentId]);

  const clearActivitySegment = useCallback((turnId?: string) => {
    if (!turnId || activityTurnIdRef.current === turnId) {
      activitySegmentRef.current = null;
      activityTurnIdRef.current = null;
    }
    if (!turnId || fileEditTurnIdRef.current === turnId) {
      fileEditSegmentRef.current = null;
      fileEditTurnIdRef.current = null;
    }
  }, []);

  const closeActiveAssistantStream = useCallback((turnId: string) => {
    const closedStreamId = buffer.current?.turnId === turnId
      ? buffer.current.messageId
      : activeAssistantRef.current?.turnId === turnId
        ? activeAssistantRef.current.id
        : undefined;
    if (closedStreamId) closedAssistantStreamIdsRef.current.add(closedStreamId);
    if (buffer.current?.turnId === turnId) buffer.current = null;
    if (activeAssistantRef.current?.turnId === turnId) activeAssistantRef.current = null;
  }, []);

  const resolveActiveAssistantIndex = useCallback((
    prev: UIMessage[],
    turn: Pick<UIMessageTurnFields, "turnId">,
  ): number | null => {
    const cursor = activeAssistantRef.current;
    if (!cursor || cursor.turnId !== turn.turnId) return null;
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
    activeAssistantRef.current = { id: cursor.id, index: idx, turnId: turn.turnId };
    return idx;
  }, []);

  const appendAnswerChunk = useCallback(
    (
      prev: UIMessage[],
      chunk: string,
      streamId: string | undefined,
      sourceChannel: string | undefined,
      turn: UIMessageTurnFields,
    ): UIMessage[] => {
      let next = prev;
      let targetIndex = streamId
        ? next.findIndex((message) => (
            message.id === streamId
            && message.role === "assistant"
            && message.kind !== "trace"
            && matchesTurn(message, turn)
          ))
        : resolveActiveAssistantIndex(next, turn);
      if (targetIndex === -1) targetIndex = null;

      if (targetIndex === null) {
        targetIndex = findActiveAssistantPlaceholderIndex(next, turn);
      }
      if (targetIndex === null && !streamId) {
        targetIndex = findStreamingAssistantIndex(
          next,
          closedAssistantStreamIdsRef.current,
          turn,
        );
      }
      if (targetIndex === null) {
        const id = streamId ?? crypto.randomUUID();
        next = [
          ...next,
          {
            id,
            role: "assistant",
            content: "",
            isStreaming: true,
            ...turn,
            createdAt: Date.now(),
          },
        ];
        targetIndex = next.length - 1;
      }

      const target = next[targetIndex];
      const mergedId = streamId ?? target.id;
      const merged: UIMessage = {
        ...target,
        id: mergedId,
        content: target.content + chunk,
        isStreaming: true,
        ...(sourceChannel ? { sourceChannel } : {}),
        ...turn,
      };
      closedAssistantStreamIdsRef.current.delete(merged.id);
      activeAssistantRef.current = { id: merged.id, index: targetIndex, turnId: turn.turnId };
      buffer.current = { messageId: merged.id, turnId: turn.turnId };
      return replaceMessageAt(next, targetIndex, merged);
    },
    [resolveActiveAssistantIndex],
  );

  const applyPendingStreamEvents = useCallback(
    (prev: UIMessage[], events: PendingStreamEvent[]): UIMessage[] => {
      let next = prev;
      for (let i = 0; i < events.length;) {
        const current = events[i];
        const kind = current.kind;
        const streamId = current.kind === "delta" ? current.streamId : undefined;
        const sourceChannel = current.kind === "delta" ? current.sourceChannel : undefined;
        const turn = current.turn;
        let text = "";
        while (i < events.length) {
          const event = events[i];
          if (event.kind !== kind) break;
          if (event.turn.turnId !== turn.turnId) break;
          if (kind === "delta" && (event.kind !== "delta" || event.streamId !== streamId)) break;
          text += event.text;
          i += 1;
        }
        next = kind === "delta"
          ? appendAnswerChunk(next, text, streamId, sourceChannel, turn)
          : attachReasoningChunk(next, text, turn, {
              ensure: () => ensureActivitySegmentId(turn.turnId),
            });
      }
      return next;
    },
    [appendAnswerChunk, ensureActivitySegmentId],
  );

  const flushPendingStreamEvents = useCallback((options?: {
    closeAnswerSegment?: boolean;
    finalAnswerText?: string;
    streamId?: string;
    turn?: UIMessageTurnFields;
  }) => {
    if (streamFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    const events = pendingStreamEventsRef.current;
    const finalAnswerText = options?.finalAnswerText;
    if (events.length === 0 && finalAnswerText === undefined) {
      if (options?.closeAnswerSegment && options.turn) {
        closeActiveAssistantStream(options.turn.turnId);
      }
      return;
    }
    pendingStreamEventsRef.current = [];
    setMessages((prev) => {
      let next = events.length > 0 ? applyPendingStreamEvents(prev, events) : prev;
      if (finalAnswerText !== undefined && options?.turn) {
        const turn = options.turn;
        const streamTargetIndex = options?.streamId
          ? next.findIndex((message) => (
              message.id === options.streamId
              && message.role === "assistant"
              && message.kind !== "trace"
              && matchesTurn(message, turn)
            ))
          : -1;
        const targetIndex =
          (streamTargetIndex >= 0 ? streamTargetIndex : null)
          ?? (!options?.streamId ? resolveActiveAssistantIndex(next, turn) : null)
          ?? (!options?.streamId
            ? findStreamingAssistantIndex(next, closedAssistantStreamIdsRef.current, turn)
            : null)
          ?? (!options?.streamId ? findLatestAssistantAnswerIndex(next, turn) : null);
          if (targetIndex !== null) {
            const target = next[targetIndex];
            next = replaceMessageAt(next, targetIndex, {
              ...target,
              id: options?.streamId ?? target.id,
              content: finalAnswerText,
              isStreaming: true,
              ...turn,
            });
          } else {
            const id = options?.streamId ?? crypto.randomUUID();
            closedAssistantStreamIdsRef.current.add(id);
            next = [
              ...next,
              {
                id,
                role: "assistant",
                content: finalAnswerText,
                isStreaming: true,
                ...turn,
                createdAt: Date.now(),
              },
            ];
          }
        }
      if (options?.closeAnswerSegment && options.turn) {
        closeActiveAssistantStream(options.turn.turnId);
      }
      return next;
    });
  }, [applyPendingStreamEvents, closeActiveAssistantStream, resolveActiveAssistantIndex]);

  const attachPlaybackSegmentToMessage = useCallback((segment: AssistantPlaybackSegment) => {
    setMessages((prev) => {
      const index = prev.findIndex(
        (message) => message.role === "assistant"
          && message.kind !== "trace"
          && message.id === segment.messageId,
      );
      const targetIndex = index >= 0 ? index : null;
      if (targetIndex === null) return prev;
      const target = prev[targetIndex];
      const previous = target.playbackSegments ?? [];
      const replaced = previous.some((item) => item.segmentIndex === segment.segmentIndex)
        ? previous.map((item) => item.segmentIndex === segment.segmentIndex ? segment : item)
        : [...previous, segment];
      const merged: UIMessage = {
        ...target,
        playbackSegments: replaced.sort((a, b) => a.segmentIndex - b.segmentIndex),
      };
      return replaceMessageAt(prev, targetIndex, merged);
    });
  }, []);

  const schedulePendingStreamFlush = useCallback(() => {
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = -1;
    const frameId = window.requestAnimationFrame(() => {
      streamFrameRef.current = null;
      const events = pendingStreamEventsRef.current;
      if (events.length === 0) return;
      pendingStreamEventsRef.current = [];
      setMessages((prev) => applyPendingStreamEvents(prev, events));
    });
    if (streamFrameRef.current === -1) {
      streamFrameRef.current = frameId;
    }
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
    closedTurnIdsRef.current.clear();
    activeTurnIdsRef.current.clear();
    streamedTurnIdsRef.current.clear();
    turnSourceChannelsRef.current.clear();
    turnNotificationTextRef.current.clear();
    pendingSpeechRef.current.clear();
    clearActivitySegment();
    clearPendingStreamWork();
    suppressedTurnIdsRef.current.clear();
    setTurnModelName(null);
    setTurnModelProvider(null);
    stopAssistantPlayback();
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
    closedTurnIdsRef.current.clear();
    activeTurnIdsRef.current.clear();
    streamedTurnIdsRef.current.clear();
    turnSourceChannelsRef.current.clear();
    turnNotificationTextRef.current.clear();
    pendingSpeechRef.current.clear();
    clearActivitySegment();
    clearPendingStreamWork();
    suppressedTurnIdsRef.current.clear();
    stopAssistantPlayback();
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

      if (ev.event === "error") {
        const failedTurnId = typeof ev.turn_id === "string" && ev.turn_id
          ? ev.turn_id
          : null;
        if (!failedTurnId) return;
        closedTurnIdsRef.current.add(failedTurnId);
        activeTurnIdsRef.current.delete(failedTurnId);
        const hasActiveTurns = activeTurnIdsRef.current.size > 0;
        setIsStreaming(hasActiveTurns);
        if (!hasActiveTurns) {
          setRunStartedAt(null);
          setTurnModelName(null);
          setTurnModelProvider(null);
        }
        setMessages((prev) => prev.map((message) => (
          message.isStreaming && message.turnId === failedTurnId
            ? { ...message, isStreaming: false }
            : message
        )));
        if (buffer.current?.turnId === failedTurnId) buffer.current = null;
        if (activeAssistantRef.current?.turnId === failedTurnId) {
          activeAssistantRef.current = null;
        }
        streamedTurnIdsRef.current.delete(failedTurnId);
        turnSourceChannelsRef.current.delete(failedTurnId);
        turnNotificationTextRef.current.delete(failedTurnId);
        clearActivitySegment(failedTurnId);
        return;
      }

      if (ev.event === "delta") {
        const turn = turnFieldsFromEvent(ev, "answer");
        if (!turn) return;
        if (closedTurnIdsRef.current.has(turn.turnId)) return;
        if (suppressedTurnIdsRef.current.has(turn.turnId)) return;
        const chunk = typeof ev.text === "string" ? ev.text : "";
        if (!chunk) return;
        streamedTurnIdsRef.current.add(turn.turnId);
        const deltaSource = getInboundSourceChannel(ev);
        if (deltaSource) turnSourceChannelsRef.current.set(turn.turnId, deltaSource);
        const currentNotificationText = turnNotificationTextRef.current.get(turn.turnId);
        turnNotificationTextRef.current.set(turn.turnId, {
          text: appendNotificationPreview(
            currentNotificationText?.segmentEnded ? "" : currentNotificationText?.text ?? "",
            chunk,
          ),
          segmentEnded: false,
        });
        clearActivitySegment(turn.turnId);
        activeTurnIdsRef.current.add(turn.turnId);
        setIsStreaming(true);
        pendingStreamEventsRef.current.push({
          kind: "delta",
          text: chunk,
          streamId: String(ev.stream_id ?? chatId),
          ...(deltaSource ? { sourceChannel: deltaSource } : {}),
          turn,
        });
        schedulePendingStreamFlush();
        return;
      }

      if (ev.event === "reasoning_delta") {
        const turn = turnFieldsFromEvent(ev, "reasoning");
        if (!turn) return;
        if (closedTurnIdsRef.current.has(turn.turnId)) return;
        if (suppressedTurnIdsRef.current.has(turn.turnId)) return;
        const chunk = ev.text;
        if (!chunk) return;
        if (fileEditTurnIdRef.current === turn.turnId) clearActivitySegment(turn.turnId);
        activeTurnIdsRef.current.add(turn.turnId);
        setIsStreaming(true);
        pendingStreamEventsRef.current.push({ kind: "reasoning", text: chunk, turn });
        schedulePendingStreamFlush();
        return;
      }

      if (ev.event === "vision_caption_delta") {
        if (ev.turn_id && closedTurnIdsRef.current.has(ev.turn_id)) return;
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
        const turn = turnFieldsFromEvent(ev, "answer");
        if (!turn) return;
        flushPendingStreamEvents({
          closeAnswerSegment: true,
          streamId: String(ev.stream_id ?? chatId),
          turn,
          ...(typeof ev.text === "string" ? { finalAnswerText: ev.text } : {}),
        });
        if (suppressedTurnIdsRef.current.has(turn.turnId)) return;
        const currentNotificationText = turnNotificationTextRef.current.get(turn.turnId);
        const eventText = typeof ev.text === "string" ? ev.text : "";
        turnNotificationTextRef.current.set(turn.turnId, {
          text: currentNotificationText && !currentNotificationText.segmentEnded
            ? currentNotificationText.text
            : appendNotificationPreview("", eventText),
          segmentEnded: true,
          ...(currentNotificationText?.hasMedia ? { hasMedia: true } : {}),
        });
        // stream_end only means the text segment finished — the model may
        // still be executing tools.  Do NOT reset isStreaming here; the
        // definitive "turn is complete" signal is ``turn_end``.
        return;
      }

      if (ev.event === "assistant_playback_segment") {
        flushPendingStreamEvents();
        attachPlaybackSegmentToMessage(ev.segment);
        enqueueAssistantPlaybackSegment(ev.segment);
        return;
      }

      if (ev.event === "assistant_audio_start") {
        flushPendingStreamEvents();
        startAssistantAudioStream(ev.audio);
        return;
      }

      if (ev.event === "assistant_audio_chunk") {
        appendAssistantAudioChunk(ev.audio);
        return;
      }

      if (ev.event === "assistant_audio_end") {
        flushPendingStreamEvents();
        void finishAssistantAudioStream(ev.audio);
        const turn = turnFieldsFromEvent(ev, "answer");
        if (!turn) return;
        pendingSpeechRef.current.set(turn.turnId, ev.audio);
        return;
      }

      if (ev.event === "assistant_audio_error") {
        failAssistantAudioStream(ev.audio.audioId);
        return;
      }

      flushPendingStreamEvents();

      if (ev.event === "reasoning_end") {
        const turn = turnFieldsFromEvent(ev, "reasoning");
        if (!turn) return;
        if (suppressedTurnIdsRef.current.has(turn.turnId)) return;
        setMessages((prev) => closeReasoningStreamForTurn(prev, turn.turnId));
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
          const finishedLocalTurnIds = new Set(
            [...activeTurnIdsRef.current].filter(
              (turnId) => !turnSourceChannelsRef.current.has(turnId),
            ),
          );
          for (const turnId of finishedLocalTurnIds) {
            closedTurnIdsRef.current.add(turnId);
            activeTurnIdsRef.current.delete(turnId);
            clearActivitySegment(turnId);
          }
          setIsStreaming(activeTurnIdsRef.current.size > 0);
          setMessages((prev) => prev.map((message) => (
            message.isStreaming && message.turnId && finishedLocalTurnIds.has(message.turnId)
              ? { ...message, isStreaming: false }
              : message
          )));
        }
        return;
      }

      if (ev.event === "turn_model_updated") {
        if (ev.is_fallback === false) {
          setTurnModelName(null);
          setTurnModelProvider(null);
        } else {
          setTurnModelName(ev.model_name);
          setTurnModelProvider(ev.provider ?? null);
        }
        return;
      }

      if (ev.event === "turn_end") {
        const turn = turnFieldsFromEvent(ev, "complete");
        if (!turn) return;
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
        closedTurnIdsRef.current.add(turn.turnId);
        activeTurnIdsRef.current.delete(turn.turnId);
        setIsStreaming(activeTurnIdsRef.current.size > 0);
        setRunStartedAt(null);
        setTurnModelName(null);
        setTurnModelProvider(null);
        setMessages((prev) => {
          let finalized = pendingCaptionEvents.length > 0
            ? mergePendingCaptionEvents(prev, pendingCaptionEvents)
            : prev;
          finalized = finalized.map((m) => (
            m.isStreaming && matchesTurn(m, turn)
              ? { ...m, isStreaming: false }
              : m
          ));
          finalized = pruneReasoningOnlyPlaceholders(finalized, turn.turnId);
          finalized = finalizeUserVisionCaptionStreaming(finalized);
          if (typeof ev.latency_ms === "number" && ev.latency_ms >= 0) {
            finalized = stampLastAssistantLatency(
              finalized,
              Math.round(ev.latency_ms),
              turn.turnId,
            );
          }
          if (ev.usage && typeof ev.usage === "object") {
            finalized = stampLastAssistantUsage(finalized, ev.usage, turn.turnId);
          }
          finalized = stampLastAssistantResponseModel(finalized, ev, turn.turnId);
          finalized = stampLastAssistantTs(finalized, Date.now(), turn.turnId);
          const pendingSpeech = pendingSpeechRef.current.get(turn.turnId);
          if (pendingSpeech) {
            const targetIndex = findSpeechTargetIndex(finalized, turn.turnId);
            if (targetIndex >= 0) {
              finalized = replaceMessageAt(finalized, targetIndex, {
                ...finalized[targetIndex],
                speech: pendingSpeech,
              });
              pendingSpeechRef.current.delete(turn.turnId);
            }
          }
          if (buffer.current?.turnId === turn.turnId) buffer.current = null;
          if (activeAssistantRef.current?.turnId === turn.turnId) {
            activeAssistantRef.current = null;
          }
          clearActivitySegment(turn.turnId);
          return finalized;
        });
        suppressedTurnIdsRef.current.delete(turn.turnId);
        captionPartsRef.current = new Map();
        captionImageCountRef.current = 0;
        requestTrayBlinkForStreamTurnEnd(
          chatId,
          streamedTurnIdsRef.current.has(turn.turnId),
          turnSourceChannelsRef.current.get(turn.turnId),
          trayNotifyOptions.current,
          turnNotificationTextRef.current.get(turn.turnId)?.text,
          turnNotificationTextRef.current.get(turn.turnId)?.hasMedia,
        );
        streamedTurnIdsRef.current.delete(turn.turnId);
        turnSourceChannelsRef.current.delete(turn.turnId);
        turnNotificationTextRef.current.delete(turn.turnId);
        onTurnEndRef.current?.();
        return;
      }

      if (ev.event === "user") {
        const turn = turnFieldsFromEvent(ev, "user");
        if (!turn) return;
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
          turnSourceChannelsRef.current.set(turn.turnId, ev.source_channel);
        }

        // 外部 channel 推来的用户消息：仅追加，不干扰本地正在进行的流式状态。
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "user" as const,
            content,
            ...turn,
            createdAt: Date.now(),
            ...(media ? { media } : {}),
            ...(ev.source_channel ? { sourceChannel: ev.source_channel } : {}),
          },
        ]);
        requestTrayBlinkForInboxEvent(chatId, ev, trayNotifyOptions.current);
        return;
      }

      if (ev.event === "message") {
        const fallbackPhase: UITurnPhase = ev.kind === "reasoning"
          ? "reasoning"
          : ev.kind === "tool_hint" || ev.kind === "progress"
            ? "activity"
            : "answer";
        const turn = turnFieldsFromEvent(ev, fallbackPhase);
        if (!turn) return;
        if (
          suppressedTurnIdsRef.current.has(turn.turnId) &&
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
          if (fileEditTurnIdRef.current === turn.turnId) clearActivitySegment(turn.turnId);
          setMessages((prev) => closeReasoningStreamForTurn(
            attachReasoningChunk(prev, line, turn, {
              ensure: () => ensureActivitySegmentId(turn.turnId),
            }),
            turn.turnId,
          ));
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
            const segmentId = ensureActivitySegmentId(turn.turnId);
            const last = prev[prev.length - 1];
            if (
              last
              && last.kind === "trace"
              && !last.isStreaming
              && matchesTurn(last, turn)
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
                ...turn,
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
                ...turn,
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
        const content = ev.text;

        // A complete (non-streamed) assistant message. If a stream was in
        // flight, drop the placeholder so we don't render the text twice.
        // Do NOT reset isStreaming here — only ``turn_end`` signals that
        // the full turn (all tool calls + final text) is complete.
        clearActivitySegment(turn.turnId);
        setMessages((prev) => {
          const activeId = buffer.current?.turnId === turn.turnId
            ? buffer.current.messageId
            : undefined;
          if (buffer.current?.turnId === turn.turnId) buffer.current = null;
          if (activeAssistantRef.current?.turnId === turn.turnId) {
            activeAssistantRef.current = null;
          }
          const filtered = activeId ? prev.filter((m) => m.id !== activeId) : prev;
          const lat =
            typeof ev.latency_ms === "number" && ev.latency_ms >= 0
              ? Math.round(ev.latency_ms)
              : undefined;
          return absorbCompleteAssistantMessage(filtered, {
            content,
            ...turn,
            ...(hasMedia ? { media } : {}),
            ...(ev.tha_played ? { thaPlayed: true } : {}),
            ...(lat !== undefined ? { latencyMs: lat } : {}),
            ...(ev.usage ? { usage: ev.usage } : {}),
            ...(ev.source_channel ? { sourceChannel: ev.source_channel } : {}),
            ...(ev.channel_delivery ? { channelDelivery: true } : {}),
            ...(ev.user_initiated_delivery ? { userInitiatedDelivery: true } : {}),
            ...(ev.cron_job_id ? { cronJobId: ev.cron_job_id } : {}),
            ...(ev.cron_job_name ? { cronJobName: ev.cron_job_name } : {}),
            ...(ev.response_model ? { responseModel: ev.response_model } : {}),
            ...(ev.response_provider ? { responseProvider: ev.response_provider } : {}),
            ...(typeof ev.fallback_used === "boolean"
              ? { fallbackUsed: ev.fallback_used }
              : {}),
            ...(ev.fallback_models?.length ? { fallbackModels: ev.fallback_models } : {}),
          });
        });
        if (hasMedia) {
          suppressedTurnIdsRef.current.add(turn.turnId);
        }
        const messageSource = getInboundSourceChannel(ev);
        if (messageSource) turnSourceChannelsRef.current.set(turn.turnId, messageSource);
        if (streamedTurnIdsRef.current.has(turn.turnId)) {
          const currentNotificationText = turnNotificationTextRef.current.get(turn.turnId);
          turnNotificationTextRef.current.set(turn.turnId, {
            text: content.trim()
              ? appendNotificationPreview("", content)
              : currentNotificationText?.text ?? "",
            segmentEnded: true,
            ...(hasMedia ? { hasMedia: true } : {}),
          });
        } else {
          turnNotificationTextRef.current.delete(turn.turnId);
          requestTrayBlinkForInboxEvent(chatId, ev, trayNotifyOptions.current);
        }
        return;
      }
      if (ev.event === "file_edit") {
        const turn = turnFieldsFromEvent(ev, "activity");
        if (!turn) return;
        const edits = Array.isArray(ev.edits) ? ev.edits : [];
        if (edits.length === 0) return;
        const normalized = mergeFileEdits(undefined, edits);
        if (normalized.length === 0) return;
        const opensFileEditPhase = normalized.some(
          (edit) => edit.status === "editing" || edit.phase === "start",
        );
        let eventSegmentId = fileEditTurnIdRef.current === turn.turnId
          ? fileEditSegmentRef.current
          : null;
        if (!eventSegmentId && opensFileEditPhase) {
          eventSegmentId = detachedActivitySegmentId(turn.turnId);
          fileEditSegmentRef.current = eventSegmentId;
          fileEditTurnIdRef.current = turn.turnId;
        }
        setMessages((prev) => {
          let segmentId = eventSegmentId;
          const targetIndex = findFileEditTraceIndex(prev, segmentId, normalized, turn);
          if (targetIndex !== null) {
            const target = prev[targetIndex];
            segmentId = target.activitySegmentId
              ?? segmentId
              ?? detachedActivitySegmentId(turn.turnId);
            if (opensFileEditPhase) {
              fileEditSegmentRef.current = segmentId;
              fileEditTurnIdRef.current = turn.turnId;
            }
            const merged: UIMessage = {
              ...target,
              fileEdits: mergeFileEdits(target.fileEdits, normalized),
              activitySegmentId: segmentId,
              ...turn,
            };
            return replaceMessageAt(prev, targetIndex, merged);
          }
          segmentId = segmentId ?? detachedActivitySegmentId(turn.turnId);
          if (opensFileEditPhase) {
            fileEditSegmentRef.current = segmentId;
            fileEditTurnIdRef.current = turn.turnId;
          }
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
              ...turn,
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
      closedTurnIdsRef.current.clear();
      activeTurnIdsRef.current.clear();
      streamedTurnIdsRef.current.clear();
      turnSourceChannelsRef.current.clear();
      turnNotificationTextRef.current.clear();
      clearActivitySegment();
      clearPendingStreamWork();
      if (streamEndTimerRef.current !== null) {
        clearTimeout(streamEndTimerRef.current);
        streamEndTimerRef.current = null;
      }
    };
  }, [
    chatId,
    attachPlaybackSegmentToMessage,
    client,
    clearActivitySegment,
    clearPendingStreamWork,
    detachedActivitySegmentId,
    ensureActivitySegmentId,
    flushPendingStreamEvents,
    flushPendingCaptionEvents,
    mergePendingCaptionEvents,
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

      flushPendingStreamEvents();
      flushPendingCaptionEvents();
      setTurnModelName(null);
      setTurnModelProvider(null);
      captionPartsRef.current = new Map();
      captionImageCountRef.current = hasImages ? images!.length : 0;
      const turnId = crypto.randomUUID();
      activeTurnIdsRef.current.add(turnId);
      const previews = hasImages ? images!.map((i) => i.preview) : undefined;
      setMessages((prev) => {
        if (!isStreaming) {
          buffer.current = null;
          activeAssistantRef.current = null;
          closedAssistantStreamIdsRef.current.clear();
          clearActivitySegment();
        }
        const existingMessages = isStreaming ? prev : pruneReasoningOnlyPlaceholders(prev);
        return [
          ...existingMessages,
          {
            id: crypto.randomUUID(),
            role: "user",
            content,
            turnId,
            turnPhase: "user",
            turnSeq: 0,
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
      client.sendMessage(chatId, content, wireMedia, { ...options, turnId });
    },
    [chatId, clearActivitySegment, client, flushPendingStreamEvents, isStreaming],
  );

  const stop = useCallback(() => {
    if (!chatId) return;
    flushPendingStreamEvents();
    setIsStreaming(false);
    setTurnModelName(null);
    setTurnModelProvider(null);
    for (const turnId of activeTurnIdsRef.current) closedTurnIdsRef.current.add(turnId);
    setMessages((prev) => {
      buffer.current = null;
      activeAssistantRef.current = null;
      closedAssistantStreamIdsRef.current.clear();
      activeTurnIdsRef.current.clear();
      clearActivitySegment();
      return prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
    });
    suppressedTurnIdsRef.current.clear();
    pendingSpeechRef.current.clear();
    stopAssistantPlayback();
    client.sendMessage(chatId, "/stop");
  }, [chatId, clearActivitySegment, client, flushPendingStreamEvents]);

  return {
    messages,
    isStreaming,
    runStartedAt,
    goalState,
    turnModelName,
    turnModelProvider,
    send,
    stop,
    setMessages,
    replaceMessagesFromSnapshot,
    streamError,
    dismissStreamError,
  };
}
