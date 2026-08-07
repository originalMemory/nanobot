import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// localStorage shim (happy-dom may not provide a full implementation)
// ---------------------------------------------------------------------------

function createTestStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.get(String(key)) ?? null; },
    key(index: number) { return Array.from(store.keys())[index] ?? null; },
    removeItem(key: string) { store.delete(String(key)); },
    setItem(key: string, value: string) { store.set(String(key), String(value)); },
  };
}

if (typeof window !== "undefined") {
  try {
    localStorage.setItem("__test__", "1");
    localStorage.removeItem("__test__");
  } catch {
    const storage = createTestStorage();
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  }
}

// ---------------------------------------------------------------------------
// crypto.randomUUID shim
// ---------------------------------------------------------------------------

if (!("randomUUID" in globalThis.crypto)) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () =>
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// window.electronAPI shim – NOT present by default; tests that need it set it
// up individually via vi.stubGlobal / mockElectronAPI() helper below.
// ---------------------------------------------------------------------------

export function mockElectronAPI(
  store: Record<string, unknown> = {},
): { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (key: string) => store[key] ?? undefined);
  const set = vi.fn(async (key: string, value: unknown) => { store[key] = value; });
  // Assign directly to window (not replace it) so document remains intact
  const noop = () => () => {};
  Object.defineProperty(window, "electronAPI", {
    value: {
      config: { get, set },
      wallpaper: {
        getConfig: vi.fn(async () => ({
          source: "url",
          url: "",
          directory: "",
          localOrder: "sequential",
          localIndex: -1,
          intervalMinutes: 1,
        })),
        setConfig: vi.fn(async (config: Record<string, unknown>) => config),
        chooseDirectory: vi.fn(async () => null),
        onUpdate: noop,
        onDisabled: noop,
      },
    },
    configurable: true,
    writable: true,
  });
  return { get, set };
}

export function clearElectronAPI() {
  if (typeof window !== "undefined" && "electronAPI" in window) {
    // @ts-expect-error test teardown
    delete window.electronAPI;
  }
}

beforeEach(() => {
  clearElectronAPI();
});
