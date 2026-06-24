import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import type { BootstrapResponse } from "@/lib/types";

const fetchBootstrapMock = vi.hoisted(() => vi.fn());
const deriveWsUrlMock = vi.hoisted(() => vi.fn());
const fetchInboxThreadMock = vi.hoisted(() => vi.fn());
const fetchSettingsMock = vi.hoisted(() => vi.fn());
const loadSavedSecretMock = vi.hoisted(() => vi.fn(() => ""));
const clientInstances = vi.hoisted(
  () =>
    [] as Array<{
      connect: ReturnType<typeof vi.fn>;
      updateUrl: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      onRuntimeModelUpdate: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/i18n", () => ({
  bootstrapAppLanguage: vi.fn(async () => {}),
}));

vi.mock("@/components/InboxSidebar", () => ({
  InboxSidebar: (): null => null,
}));

vi.mock("@/components/InboxView", () => ({
  InboxView: (): null => null,
}));

vi.mock("@/components/ScreenshotPreviewModal", () => ({
  ScreenshotPreviewModal: (): null => null,
}));

vi.mock("@/components/settings/SettingsView", () => ({
  SettingsView: (): null => null,
}));

vi.mock("@/components/WindowTitleBar", () => ({
  WindowTitleBar: (): null => null,
}));

vi.mock("@/lib/nanobot-client", () => ({
  NanobotClient: vi.fn().mockImplementation(() => {
    const client = {
      connect: vi.fn(),
      updateUrl: vi.fn(),
      close: vi.fn(),
      onRuntimeModelUpdate: vi.fn(() => vi.fn()),
    };
    clientInstances.push(client);
    return client;
  }),
}));

vi.mock("@/lib/api", () => ({
  fetchInboxThread: fetchInboxThreadMock,
  fetchSettings: fetchSettingsMock,
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/bootstrap", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bootstrap")>(
    "@/lib/bootstrap",
  );
  return {
    ...actual,
    deriveWsUrl: deriveWsUrlMock,
    fetchBootstrap: fetchBootstrapMock,
    loadSavedSecret: loadSavedSecretMock,
    saveGatewayUrl: vi.fn(async () => {}),
    saveSecret: vi.fn(),
  };
});

function bootstrap(token: string, expiresIn = 30): BootstrapResponse {
  return {
    token,
    ws_path: "/",
    expires_in: expiresIn,
    model_name: null,
  };
}

async function settleInitialBoot() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Electron App token refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fetchBootstrapMock.mockReset();
    deriveWsUrlMock.mockReset();
    fetchInboxThreadMock.mockReset();
    fetchSettingsMock.mockReset();
    loadSavedSecretMock.mockReset();
    loadSavedSecretMock.mockReturnValue("");
    clientInstances.length = 0;
    delete (window as Window & { electronAPI?: unknown }).electronAPI;

    deriveWsUrlMock.mockImplementation(
      (_wsPath: string, token: string) => `ws://test?token=${token}`,
    );
    fetchInboxThreadMock.mockResolvedValue(null);
    fetchSettingsMock.mockResolvedValue({
      agent: {
        bot_name: "nanobot",
        bot_icon: "",
        bot_avatar_url: null,
      },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { electronAPI?: unknown }).electronAPI;
    vi.useRealTimers();
  });

  it("ignores persisted runtime token when bootstrapping", async () => {
    loadSavedSecretMock.mockReturnValue("saved-bootstrap-secret");
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        config: {
          get: vi.fn(async () => ({
            url: "http://127.0.0.1:8765",
            token: "expired-runtime-token",
          })),
        },
      },
    });
    fetchBootstrapMock.mockResolvedValueOnce(bootstrap("tok-1", 300));

    render(<App />);
    await settleInitialBoot();

    expect(fetchBootstrapMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765",
      "saved-bootstrap-secret",
    );
  });

  it("refreshes the bootstrap token before REST auth expires", async () => {
    fetchBootstrapMock
      .mockResolvedValueOnce(bootstrap("tok-1"))
      .mockResolvedValueOnce(bootstrap("tok-2", 300));

    render(<App />);
    await settleInitialBoot();

    expect(clientInstances[0]?.connect).toHaveBeenCalledOnce();
    expect(fetchBootstrapMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchBootstrapMock).toHaveBeenCalledTimes(2);
    expect(clientInstances[0]?.updateUrl).toHaveBeenCalledWith(
      "ws://test?token=tok-2",
    );
  });

  it("closes the active client when scheduled refresh auth fails", async () => {
    const err = new Error("bootstrap failed: HTTP 401") as Error & {
      httpStatus: number;
    };
    err.httpStatus = 401;
    fetchBootstrapMock
      .mockResolvedValueOnce(bootstrap("tok-1"))
      .mockRejectedValueOnce(err);

    render(<App />);
    await settleInitialBoot();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(clientInstances[0]?.close).toHaveBeenCalledOnce();
  });

  it("retries scheduled refresh after a transient failure", async () => {
    fetchBootstrapMock
      .mockResolvedValueOnce(bootstrap("tok-1"))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(bootstrap("tok-2", 300));

    render(<App />);
    await settleInitialBoot();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchBootstrapMock).toHaveBeenCalledTimes(2);
    expect(clientInstances[0]?.updateUrl).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchBootstrapMock).toHaveBeenCalledTimes(3);
    expect(clientInstances[0]?.updateUrl).toHaveBeenCalledWith(
      "ws://test?token=tok-2",
    );
  });
});
