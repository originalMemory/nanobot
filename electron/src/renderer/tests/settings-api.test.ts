import { describe, expect, it, vi, afterEach } from "vitest";

import {
  fetchSettings,
  updateSettings,
  updateProviderSettings,
  updateWebSearchSettings,
  updateImageGenerationSettings,
  runCliAppAction,
  runMcpPresetAction,
  saveCustomMcpServer,
  importMcpConfig,
} from "@/lib/api";

const TOKEN = "test-token";
const BASE = "http://localhost:8765";

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// fetchSettings
// ---------------------------------------------------------------------------

describe("fetchSettings", () => {
  it("calls /api/settings with bearer token", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await fetchSettings(TOKEN, BASE).catch(() => {});
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/settings`,
      expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
  });
});

// ---------------------------------------------------------------------------
// updateSettings
// ---------------------------------------------------------------------------

describe("updateSettings", () => {
  it("sends model_preset query param", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await updateSettings(TOKEN, { modelPreset: "fast" }, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("model_preset=fast");
  });

  it("sends vision_model and vision_provider", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await updateSettings(TOKEN, { visionModel: "gemini-2.5-flash", visionProvider: "gemini" }, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("vision_model=gemini-2.5-flash");
    expect(url).toContain("vision_provider=gemini");
  });

  it("sends empty string to clear vision_model", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await updateSettings(TOKEN, { visionModel: null }, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("vision_model=");
  });

  it("sends max_tokens, context_window_tokens, max_messages", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await updateSettings(TOKEN, { maxTokens: 8192, contextWindowTokens: 1000000, maxMessages: 200 }, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("max_tokens=8192");
    expect(url).toContain("context_window_tokens=1000000");
    expect(url).toContain("max_messages=200");
  });
});

// ---------------------------------------------------------------------------
// updateProviderSettings
// ---------------------------------------------------------------------------

describe("updateProviderSettings", () => {
  it("sends provider, api_key, and api_base params", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await updateProviderSettings(TOKEN, { provider: "openai", apiKey: "sk-123", apiBase: "https://api.openai.com" }, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("provider=openai");
    expect(url).toContain("api_key=sk-123");
    expect(url).toContain("api_base=");
  });
});

// ---------------------------------------------------------------------------
// updateWebSearchSettings
// ---------------------------------------------------------------------------

describe("updateWebSearchSettings", () => {
  it("sends provider and max_results", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await updateWebSearchSettings(TOKEN, { provider: "tavily", maxResults: 10 }, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("provider=tavily");
    expect(url).toContain("max_results=10");
  });
});

// ---------------------------------------------------------------------------
// updateImageGenerationSettings
// ---------------------------------------------------------------------------

describe("updateImageGenerationSettings", () => {
  it("sends all required image generation params", async () => {
    const fetch = mockFetch({ agent: {}, requires_restart: false });
    await updateImageGenerationSettings(
      TOKEN,
      { enabled: true, provider: "openrouter", model: "dall-e-3", defaultAspectRatio: "16:9", defaultImageSize: "1K", maxImagesPerTurn: 2 },
      BASE,
    ).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("enabled=true");
    expect(url).toContain("provider=openrouter");
    expect(url).toContain("model=dall-e-3");
    expect(url).toContain("default_aspect_ratio=16%3A9");
    expect(url).toContain("max_images_per_turn=2");
  });
});

// ---------------------------------------------------------------------------
// runCliAppAction
// ---------------------------------------------------------------------------

describe("runCliAppAction", () => {
  it("sends install action with name param", async () => {
    const fetch = mockFetch({ apps: [], installed_count: 0 });
    await runCliAppAction(TOKEN, "install", "anygen", BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("/api/settings/cli-apps/install");
    expect(url).toContain("name=anygen");
  });

  it("sends uninstall action", async () => {
    const fetch = mockFetch({ apps: [], installed_count: 0 });
    await runCliAppAction(TOKEN, "uninstall", "anygen", BASE).catch(() => {});
    expect(String(fetch.mock.calls[0][0])).toContain("/api/settings/cli-apps/uninstall");
  });
});

// ---------------------------------------------------------------------------
// runMcpPresetAction
// ---------------------------------------------------------------------------

describe("runMcpPresetAction", () => {
  it("sends enable action with name param", async () => {
    const fetch = mockFetch({ presets: [], installed_count: 0 });
    await runMcpPresetAction(TOKEN, "enable", "github", {}, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("/api/settings/mcp-presets/enable");
    expect(url).toContain("name=github");
  });

  it("sends credentials in x-mcp-values header", async () => {
    const fetch = mockFetch({ presets: [], installed_count: 0 });
    await runMcpPresetAction(TOKEN, "enable", "github", { GITHUB_TOKEN: "ghp_abc" }, BASE).catch(() => {});
    const headers = fetch.mock.calls[0][1]?.headers ?? {};
    expect(JSON.stringify(headers)).toContain("X-Nanobot-MCP-Values");
  });
});

// ---------------------------------------------------------------------------
// saveCustomMcpServer
// ---------------------------------------------------------------------------

describe("saveCustomMcpServer", () => {
  it("calls /api/settings/mcp-presets/custom", async () => {
    const fetch = mockFetch({ presets: [], installed_count: 0 });
    await saveCustomMcpServer(TOKEN, { name: "docs", command: "npx" }, BASE).catch(() => {});
    expect(String(fetch.mock.calls[0][0])).toContain("/api/settings/mcp-presets/custom");
  });
});

// ---------------------------------------------------------------------------
// importMcpConfig
// ---------------------------------------------------------------------------

describe("importMcpConfig", () => {
  it("calls /api/settings/mcp-presets/import with config in header", async () => {
    const fetch = mockFetch({ presets: [], installed_count: 0 });
    const cfg = JSON.stringify({ mcpServers: {} });
    await importMcpConfig(TOKEN, cfg, BASE).catch(() => {});
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("/api/settings/mcp-presets/import");
    const headers = fetch.mock.calls[0][1]?.headers ?? {};
    expect(JSON.stringify(headers)).toContain("X-Nanobot-MCP-Values");
  });
});
