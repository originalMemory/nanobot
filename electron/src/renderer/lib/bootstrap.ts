import type { BootstrapResponse } from "./types";
import { isElectron } from "./env";

export const DEFAULT_GATEWAY_HTTP = "http://127.0.0.1:8765";

const SECRET_STORAGE_KEY = "nanobot-electron.bootstrap-secret";

// TODO(6.3): 迁移到 electron-store，使跨窗口共享且不受 renderer 沙箱限制
export function loadSavedSecret(): string {
  try {
    return window.localStorage.getItem(SECRET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveSecret(secret: string): void {
  try {
    window.localStorage.setItem(SECRET_STORAGE_KEY, secret);
  } catch {
    // ignore storage errors
  }
}

export function clearSavedSecret(): void {
  try {
    window.localStorage.removeItem(SECRET_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function saveGatewayUrl(url: string): Promise<void> {
  if (!isElectron) return;
  try {
    await window.electronAPI.config.set("gateway.url", url);
  } catch (e) {
    console.warn("[nanobot] failed to persist gateway URL:", e);
  }
}

export async function fetchBootstrap(
  baseUrl: string = DEFAULT_GATEWAY_HTTP,
  secret: string = "",
): Promise<BootstrapResponse> {
  const headers: Record<string, string> = {};
  if (secret) {
    headers["X-Nanobot-Auth"] = secret;
  }
  const res = await fetch(`${baseUrl}/webui/bootstrap`, {
    method: "GET",
    credentials: "omit",
    headers,
  });
  if (!res.ok) {
    const err = new Error(`bootstrap failed: HTTP ${res.status}`);
    (err as Error & { httpStatus: number }).httpStatus = res.status;
    throw err;
  }
  const body = (await res.json()) as BootstrapResponse;
  if (!body.token || !body.ws_path) {
    throw new Error("bootstrap response missing token or ws_path");
  }
  return body;
}

/**
 * Derive a WebSocket URL from the gateway HTTP base URL and the server-provided path.
 * Unlike the webui version, we don't rely on window.location (which is file:// in Electron).
 */
export function deriveWsUrl(
  wsPath: string,
  token: string,
  baseUrl: string = DEFAULT_GATEWAY_HTTP,
): string {
  const path = wsPath && wsPath.startsWith("/") ? wsPath : `/${wsPath || ""}`;
  const query = `?token=${encodeURIComponent(token)}`;
  const httpBase = baseUrl.replace(/\/$/, "");
  const wsBase = httpBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}${path}${query}`;
}
