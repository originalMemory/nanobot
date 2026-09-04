// LiveTalking 音频流桥接：把 nanobot 流式 TTS PCM 转发给本地数字人服务
// 委托优先级: livetalking > psb > 本地播放。会话由 AvatarCompanionPanel 建立。

type LivetalkingApi = NonNullable<Window["electronAPI"]>["livetalking"];

function api(): LivetalkingApi | null {
  return window.electronAPI?.livetalking ?? null;
}

/** 当前伴侣会话（面板建立后非空）。 */
let sessionSource: (() => string | null) | null = null;
let connectSource: (() => Promise<boolean>) | null = null;
let disconnectSource: (() => void) | null = null;

export function bindAvatarCompanionSession(
  source: () => string | null,
  connect?: () => Promise<boolean>,
  disconnect?: () => void,
): void {
  sessionSource = source;
  connectSource = connect ?? null;
  disconnectSource = disconnect ?? null;
}

function sessionId(): string | null {
  return sessionSource ? sessionSource() : null;
}

let active = false;
let startRequestedAudioId: string | null = null;

export function isAvatarCompanionAudioActive(): boolean {
  return active;
}

/** 音频流开始：通知采样率。失败返回 false（调用方回退其他播放路径）。 */
export async function startLivetalkingStream(audioId: string, sampleRate: number): Promise<boolean> {
  if (!sessionId() && (!connectSource || !await connectSource())) return false;
  const sid = sessionId();
  const lt = api();
  if (!sid || !lt) return false;
  try {
    await lt.audiostreamStart(sid, sampleRate);
    active = true;
    startRequestedAudioId = audioId;
    return true;
  } catch {
    active = false;
    return false;
  }
}

export function disconnectLivetalking(): void {
  disconnectSource?.();
  setCompanionMode("idle");
}

/** 音频块：base64 PCM 转发。失败置 inactive（后续块走本地，由调用方处理回退）。 */
export async function sendLivetalkingChunk(base64Pcm: string): Promise<boolean> {
  const sid = sessionId();
  const lt = api();
  if (!active || !sid || !lt) return false;
  try {
    const bytes = decodeBase64(base64Pcm);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    await lt.audiostreamChunk(sid, buffer);
    return true;
  } catch {
    active = false;
    return false;
  }
}

/** 音频流结束：静音收口。 */
export async function finishLivetalkingStream(): Promise<void> {
  const sid = sessionId();
  const lt = api();
  startRequestedAudioId = null;
  if (!active || !sid || !lt) {
    active = false;
    return;
  }
  active = false;
  try {
    await lt.audiostreamFinish(sid);
  } catch {
    /* 收口失败不影响后续 */
  }
}

export function getLivetalkingStreamAudioId(): string | null {
  return startRequestedAudioId;
}

/** 说话状态查询（轮询 UI 用）。 */
export async function isLivetalkingSpeaking(): Promise<boolean | null> {
  const sid = sessionId();
  const lt = api();
  if (!sid || !lt) return null;
  try {
    const res = (await lt.isSpeaking(sid)) as { data?: boolean };
    return res?.data === true;
  } catch {
    return null;
  }
}

/** 等待服务端确认数字人已播完，避免用音频时长猜测远端播放结束。 */
export async function waitForLivetalkingSilence(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let silentChecks = 0;
  while (Date.now() < deadline) {
    const speaking = await isLivetalkingSpeaking();
    if (speaking === false) {
      silentChecks += 1;
      if (silentChecks >= 2) return;
    } else if (speaking === true) {
      silentChecks = 0;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
}

/** 打断当前说话。 */
export async function interruptLivetalking(): Promise<void> {
  const sid = sessionId();
  const lt = api();
  if (!sid || !lt) return;
  try {
    await lt.interrupt(sid);
  } catch {
    /* 忽略 */
  }
}

/** AssistantSpeech 兜底（无流式 chunk 的历史回放等场景）。
 * ponytail: 首版不做 url 下载转发(humanaudio)，流式路径已覆盖实时对话；需要时再补。 */
export async function replayViaLivetalking(): Promise<boolean> {
  return false;
}

function decodeBase64(data: string): Uint8Array {
  const raw = window.atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// turn 状态触发（useNanobotStream 调用）
// ---------------------------------------------------------------------------

export type CompanionMode = "idle" | "working" | "speaking";

let companionMode: CompanionMode = "idle";
const modeListeners = new Set<(mode: CompanionMode) => void>();

function setCompanionMode(next: CompanionMode): void {
  companionMode = next;
  modeListeners.forEach((listener) => listener(next));
}

/** 面板订阅模式变化。 */
export function subscribeCompanionMode(listener: (mode: CompanionMode) => void): () => void {
  modeListeners.add(listener);
  listener(companionMode);
  return () => modeListeners.delete(listener);
}

/** 新回合开始: 切工作态池(任务类回复无音频时停留于此; 有音频时服务端自动退出)。 */
export function avatarCompanionTurnStart(): void {
  setCompanionMode("working");
}

/** 助手音频开始: 进入说话态（LiveTalking audiostream/start 自动退出工作态）。 */
export function avatarCompanionSpeaking(): void {
  setCompanionMode("speaking");
}

/** 回合结束: 回待机池。 */
export function avatarCompanionTurnEnd(): void {
  if (!sessionId()) setCompanionMode("idle");
}

/** 手动停止: 打断说话并回待机。 */
export function avatarCompanionInterrupt(): void {
  setCompanionMode("idle");
  void interruptLivetalking();
  disconnectLivetalking();
}
