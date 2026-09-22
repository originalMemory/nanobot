export function streamDiagnostic(event: string, fields: Record<string, unknown> = {}): void {
  if (typeof window === "undefined" || !window.nanobotHost?.fixedChatId) return;
  console.info("[nanobot-stream] " + JSON.stringify({
    at: new Date().toISOString(),
    event,
    visibility: document.visibilityState,
    ...fields,
  }));
}
