import type {
  AutomationsPayload,
  ChatSummary,
  CliAppsPayload,
  ImageGenerationSettingsUpdate,
  McpPresetsPayload,
  ModelConfigurationCreate,
  ProviderSettingsUpdate,
  SettingsPayload,
  SettingsUpdate,
  SidebarStatePayload,
  SlashCommand,
  ThaSettingsUpdate,
  PsbSettingsUpdate,
  PsbInitialState,
  PsbModelDetail,
  WebuiThreadPersistedPayload,
} from "./types";
import type {
  WorkspaceListPayload,
  WorkspaceReadImagePayload,
  WorkspaceReadPayload,
} from "./workspaceViewer";
import { DEFAULT_GATEWAY_HTTP } from "./bootstrap";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

// credentials: "omit" — Electron renderer 是 file:// origin，向 localhost 发请求属跨域，
// 不能用 "same-origin"。鉴权通过 Authorization header（Bearer token）完成，不依赖 cookie。
async function request<T>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...(init ?? {}),
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
    credentials: "omit",
  });
  if (!res.ok) {
    throw new ApiError(res.status, `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function mcpValuesHeader(values: Record<string, unknown>): HeadersInit | undefined {
  const payload: Record<string, unknown> = {};
  Object.entries(values).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) payload[key] = trimmed;
      return;
    }
    payload[key] = value;
  });
  if (!Object.keys(payload).length) return undefined;
  return { "X-Nanobot-MCP-Values": JSON.stringify(payload) };
}

function splitKey(key: string): { channel: string; chatId: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { channel: "", chatId: key };
  return { channel: key.slice(0, idx), chatId: key.slice(idx + 1) };
}

export async function listSessions(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<ChatSummary[]> {
  type Row = {
    key: string;
    created_at: string | null;
    updated_at: string | null;
    title?: string;
    preview?: string;
    run_started_at?: number | null;
  };
  const body = await request<{ sessions: Row[] }>(
    `${base}/api/sessions`,
    token,
  );
  return body.sessions.map((s) => ({
    key: s.key,
    ...splitKey(s.key),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    title: s.title ?? "",
    preview: s.preview ?? "",
    runStartedAt: s.run_started_at ?? null,
  }));
}

/** Disk-backed WebUI display thread snapshot (separate from agent session). */
export async function fetchWebuiThread(
  token: string,
  key: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<WebuiThreadPersistedPayload | null> {
  const url = `${base}/api/sessions/${encodeURIComponent(key)}/webui-thread`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as WebuiThreadPersistedPayload;
}

/** Unified inbox thread: reads the unified:default transcript via /api/inbox/thread. */
export async function fetchInboxThread(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<WebuiThreadPersistedPayload | null> {
  const url = `${base}/api/inbox/thread`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as WebuiThreadPersistedPayload;
}

export async function deleteSession(
  token: string,
  key: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<boolean> {
  const body = await request<{ deleted: boolean }>(
    `${base}/api/sessions/${encodeURIComponent(key)}/delete`,
    token,
  );
  return body.deleted;
}

export async function fetchSettings(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  return request<SettingsPayload>(`${base}/api/settings`, token);
}

export async function fetchCliApps(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<CliAppsPayload> {
  return request<CliAppsPayload>(`${base}/api/settings/cli-apps`, token);
}

export async function runCliAppAction(
  token: string,
  action: "install" | "update" | "uninstall" | "test",
  name: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<CliAppsPayload> {
  const query = new URLSearchParams();
  query.set("name", name);
  return request<CliAppsPayload>(`${base}/api/settings/cli-apps/${action}?${query}`, token);
}

export async function fetchMcpPresets(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<McpPresetsPayload> {
  return request<McpPresetsPayload>(`${base}/api/settings/mcp-presets`, token);
}

export async function runMcpPresetAction(
  token: string,
  action: "enable" | "remove" | "test",
  name: string,
  values: Record<string, string> = {},
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<McpPresetsPayload> {
  const query = new URLSearchParams();
  query.set("name", name);
  return request<McpPresetsPayload>(
    `${base}/api/settings/mcp-presets/${action}?${query}`,
    token,
    { headers: mcpValuesHeader(values) },
  );
}

export async function saveCustomMcpServer(
  token: string,
  values: Record<string, string>,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<McpPresetsPayload> {
  return request<McpPresetsPayload>(
    `${base}/api/settings/mcp-presets/custom`,
    token,
    { headers: mcpValuesHeader(values) },
  );
}

export async function importMcpConfig(
  token: string,
  config: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<McpPresetsPayload> {
  return request<McpPresetsPayload>(
    `${base}/api/settings/mcp-presets/import`,
    token,
    { headers: mcpValuesHeader({ config }) },
  );
}

export async function updateMcpServerTools(
  token: string,
  name: string,
  enabledTools: string[],
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<McpPresetsPayload> {
  return request<McpPresetsPayload>(
    `${base}/api/settings/mcp-presets/tools`,
    token,
    { headers: mcpValuesHeader({ name, enabled_tools: enabledTools }) },
  );
}

export async function listSlashCommands(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SlashCommand[]> {
  type Row = {
    command: string;
    title: string;
    description: string;
    icon: string;
    arg_hint?: string;
  };
  const body = await request<{ commands: Row[] }>(`${base}/api/commands`, token);
  return body.commands
    .filter((command) => !["/stop"].includes(command.command))
    .map((command) => ({
      command: command.command,
      title: command.title,
      description: command.description,
      icon: command.icon,
      argHint: command.arg_hint ?? "",
    }));
}

export async function fetchSidebarState(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SidebarStatePayload> {
  return request<SidebarStatePayload>(`${base}/api/webui/sidebar-state`, token);
}

export async function fetchAutomations(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<AutomationsPayload> {
  return request<AutomationsPayload>(`${base}/api/webui/automations`, token);
}

export async function runAutomationAction(
  token: string,
  action: "enable" | "disable" | "run" | "delete",
  id: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<AutomationsPayload> {
  const query = new URLSearchParams({ id });
  return request<AutomationsPayload>(
    `${base}/api/webui/automations/${action}?${query}`,
    token,
  );
}

export async function updateSidebarState(
  token: string,
  state: SidebarStatePayload,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SidebarStatePayload> {
  const query = new URLSearchParams();
  query.set("state", JSON.stringify(state));
  return request<SidebarStatePayload>(
    `${base}/api/webui/sidebar-state/update?${query}`,
    token,
  );
}

export async function updateSettings(
  token: string,
  update: SettingsUpdate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  if (update.modelPreset !== undefined) {
    query.set("model_preset", update.modelPreset ?? "default");
  }
  if (update.model !== undefined) query.set("model", update.model);
  if (update.provider !== undefined) query.set("provider", update.provider);
  if (update.timezone !== undefined) query.set("timezone", update.timezone);
  if (update.botName !== undefined) query.set("bot_name", update.botName);
  if (update.botIcon !== undefined) query.set("bot_icon", update.botIcon);
  if (update.toolHintMaxLength !== undefined) {
    query.set("tool_hint_max_length", String(update.toolHintMaxLength));
  }
  if (update.visionModel !== undefined) {
    query.set("vision_model", update.visionModel ?? "");
  }
  if (update.visionProvider !== undefined) {
    query.set("vision_provider", update.visionProvider ?? "");
  }
  if (update.visionEnabled !== undefined) {
    query.set("vision_enabled", String(update.visionEnabled));
  }
  if (update.maxTokens !== undefined) {
    query.set("max_tokens", String(update.maxTokens));
  }
  if (update.contextWindowTokens !== undefined) {
    query.set("context_window_tokens", String(update.contextWindowTokens));
  }
  if (update.maxMessages !== undefined) {
    query.set("max_messages", String(update.maxMessages));
  }
  if (update.reasoningEffort !== undefined) {
    query.set("reasoning_effort", update.reasoningEffort || "default");
  }
  return request<SettingsPayload>(`${base}/api/settings/update?${query}`, token);
}

export async function createModelConfiguration(
  token: string,
  configuration: ModelConfigurationCreate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  if (configuration.name !== undefined) query.set("name", configuration.name);
  query.set("label", configuration.label);
  query.set("provider", configuration.provider);
  query.set("model", configuration.model);
  if (configuration.reasoningEffort !== undefined) {
    query.set("reasoning_effort", configuration.reasoningEffort || "default");
  }
  return request<SettingsPayload>(
    `${base}/api/settings/model-configurations/create?${query}`,
    token,
  );
}

export async function migrateModelConfigurations(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  return request<SettingsPayload>(
    `${base}/api/settings/model-configurations/migrate`,
    token,
  );
}

export async function updateModelCallOrder(
  token: string,
  order: string[],
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  query.set("order", JSON.stringify(order));
  return request<SettingsPayload>(
    `${base}/api/settings/model-call-order/update?${query}`,
    token,
  );
}

export async function updateProviderSettings(
  token: string,
  update: ProviderSettingsUpdate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  query.set("provider", update.provider);
  if (update.apiKey !== undefined) query.set("api_key", update.apiKey);
  if (update.apiBase !== undefined) query.set("api_base", update.apiBase);
  if (update.apiType !== undefined) query.set("api_type", update.apiType);
  return request<SettingsPayload>(
    `${base}/api/settings/provider/update?${query}`,
    token,
  );
}

export async function updateWebSearchSettings(
  token: string,
  update: import("./types").WebSearchSettingsUpdate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  query.set("provider", update.provider);
  if (update.apiKey !== undefined) query.set("api_key", update.apiKey);
  if (update.baseUrl !== undefined) query.set("base_url", update.baseUrl);
  if (update.maxResults !== undefined) query.set("max_results", String(update.maxResults));
  if (update.timeout !== undefined) query.set("timeout", String(update.timeout));
  if (update.useJinaReader !== undefined) {
    query.set("use_jina_reader", String(update.useJinaReader));
  }
  return request<SettingsPayload>(
    `${base}/api/settings/web-search/update?${query}`,
    token,
  );
}

export async function updateImageGenerationSettings(
  token: string,
  update: ImageGenerationSettingsUpdate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  query.set("enabled", String(update.enabled));
  query.set("provider", update.provider);
  query.set("model", update.model);
  query.set("default_aspect_ratio", update.defaultAspectRatio);
  query.set("default_image_size", update.defaultImageSize);
  query.set("max_images_per_turn", String(update.maxImagesPerTurn));
  return request<SettingsPayload>(
    `${base}/api/settings/image-generation/update?${query}`,
    token,
  );
}

export async function updateThaSettings(
  token: string,
  update: ThaSettingsUpdate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  Object.entries(update).forEach(([key, value]) => {
    if (value !== undefined && value !== null) query.set(key, String(value));
  });
  return request<SettingsPayload>(
    `${base}/api/settings/desk-pet/tha/update?${query}`,
    token,
  );
}

export async function updateDeskPetPsbSettings(
  token: string,
  update: PsbSettingsUpdate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  Object.entries(update).forEach(([key, value]) => {
    if (value !== undefined && value !== null) query.set(key, String(value));
  });
  return request<SettingsPayload>(
    `${base}/api/settings/desk-pet/psb/update?${query}`,
    token,
  );
}

export async function fetchPsbModelDetail(
  token: string,
  modelId: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<{ model: PsbModelDetail }> {
  return request<{ model: PsbModelDetail }>(
    `${base}/api/desk-pet/psb/models/${encodeURIComponent(modelId)}`,
    token,
  );
}

export interface TtsSettingsUpdate {
  mode?: "off" | "agent" | "always";
  preset?: string;
  voice?: string;
}

export async function updateTtsSettings(
  token: string,
  update: TtsSettingsUpdate,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<SettingsPayload> {
  const query = new URLSearchParams();
  Object.entries(update).forEach(([key, value]) => {
    if (value !== undefined && value !== null) query.set(key, String(value));
  });
  return request<SettingsPayload>(
    `${base}/api/settings/tts/update?${query}`,
    token,
  );
}

export async function deletePsbModel(
  token: string,
  modelId: string,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<{ ok: boolean; clearedSelection?: boolean }> {
  return request(
    `${base}/api/desk-pet/psb/models/${encodeURIComponent(modelId)}/delete`,
    token,
  );
}

export async function savePsbInitialState(
  token: string,
  modelId: string,
  state: PsbInitialState,
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<{ model: PsbModelDetail }> {
  const query = new URLSearchParams();
  query.set("state", JSON.stringify(state));
  return request<{ model: PsbModelDetail }>(
    `${base}/api/desk-pet/psb/models/${encodeURIComponent(modelId)}/initial-state/update?${query}`,
    token,
  );
}

/** 将音频回放事件转发给已连接的 THA 窗口；有订阅者时由 THA 负责出声。 */
export async function playThaAudio(
  token: string,
  payload: { url: string; text?: string; name?: string },
  base: string = DEFAULT_GATEWAY_HTTP,
): Promise<{ ok: boolean; subscribers: number }> {
  const query = new URLSearchParams();
  query.set("url", payload.url);
  if (payload.text) query.set("text", payload.text);
  if (payload.name) query.set("name", payload.name);
  return request<{ ok: boolean; subscribers: number }>(
    `${base}/api/tha/play?${query}`,
    token,
  );
}

export async function fetchWorkspaceList(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
  path = "",
): Promise<WorkspaceListPayload> {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  const suffix = query.toString();
  const url = suffix
    ? `${base}/api/workspace/list?${suffix}`
    : `${base}/api/workspace/list`;
  return request(url, token);
}

export async function fetchWorkspaceRead(
  token: string,
  path: string,
  base: string = DEFAULT_GATEWAY_HTTP,
  signal?: AbortSignal,
): Promise<WorkspaceReadPayload> {
  const query = new URLSearchParams();
  query.set("path", path);
  return request(`${base}/api/workspace/read?${query}`, token, { signal });
}

export async function fetchDiaryList(
  token: string,
  base: string = DEFAULT_GATEWAY_HTTP,
  path = "",
): Promise<WorkspaceListPayload> {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  const suffix = query.toString();
  const url = suffix ? `${base}/api/diary/list?${suffix}` : `${base}/api/diary/list`;
  return request(url, token);
}

export async function fetchDiaryRead(
  token: string,
  path: string,
  base: string = DEFAULT_GATEWAY_HTTP,
  signal?: AbortSignal,
): Promise<WorkspaceReadPayload> {
  const query = new URLSearchParams();
  query.set("path", path);
  return request(`${base}/api/diary/read?${query}`, token, { signal });
}

export async function fetchDiaryImage(
  token: string,
  notePath: string,
  imageName: string,
  base: string = DEFAULT_GATEWAY_HTTP,
  signal?: AbortSignal,
): Promise<WorkspaceReadImagePayload> {
  const query = new URLSearchParams();
  query.set("note", notePath);
  query.set("name", imageName);
  return request(`${base}/api/diary/image?${query}`, token, { signal });
}
