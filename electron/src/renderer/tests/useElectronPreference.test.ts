import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearElectronAPI, mockElectronAPI } from "./setup";

// isElectron is evaluated at import time; hoist a mutable ref so we can flip
// it per test without reloading the module.
const envState = vi.hoisted(() => ({ isElectron: false }));
vi.mock("@/lib/env", () => ({
  get isElectron() { return envState.isElectron; },
}));

import { useElectronPreference } from "@/hooks/useElectronPreference";

afterEach(() => {
  envState.isElectron = false;
  vi.unstubAllGlobals();
  clearElectronAPI();
});

describe("useElectronPreference – non-Electron env", () => {
  it("returns the default value when electronAPI is absent", () => {
    const { result } = renderHook(() =>
      useElectronPreference("appearance.theme", "light"),
    );
    expect(result.current[0]).toBe("light");
  });

  it("setValue updates local state without touching IPC", () => {
    const { result } = renderHook(() =>
      useElectronPreference("appearance.theme", "light"),
    );
    act(() => result.current[1]("dark"));
    expect(result.current[0]).toBe("dark");
  });
});

describe("useElectronPreference – Electron env", () => {
  it("reads the stored value from electron-store on mount", async () => {
    envState.isElectron = true;
    const { get } = mockElectronAPI({ "appearance.theme": "dark" });

    const { result } = renderHook(() =>
      useElectronPreference("appearance.theme", "light"),
    );

    await waitFor(() => expect(result.current[0]).toBe("dark"));
    expect(get).toHaveBeenCalledWith("appearance.theme");
  });

  it("falls back to defaultValue when store key is absent", async () => {
    envState.isElectron = true;
    mockElectronAPI({});

    const { result } = renderHook(() =>
      useElectronPreference("appearance.theme", "light"),
    );

    // give time for the async get to resolve
    await act(async () => {});
    expect(result.current[0]).toBe("light");
  });

  it("setValue updates local state and calls IPC set", async () => {
    envState.isElectron = true;
    const { set } = mockElectronAPI({ "appearance.theme": "light" });

    const { result } = renderHook(() =>
      useElectronPreference("appearance.theme", "light"),
    );

    act(() => result.current[1]("dark"));

    expect(result.current[0]).toBe("dark");
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith("appearance.theme", "dark"),
    );
  });

  it("ignores IPC errors and keeps local state", async () => {
    envState.isElectron = true;
    const get = vi.fn().mockRejectedValue(new Error("IPC error"));
    const set = vi.fn().mockRejectedValue(new Error("IPC error"));
    Object.defineProperty(window, "electronAPI", {
      value: { config: { get, set } },
      configurable: true,
      writable: true,
    });

    const { result } = renderHook(() =>
      useElectronPreference("appearance.theme", "light"),
    );

    await act(async () => {});
    expect(result.current[0]).toBe("light");

    // setValue still updates local state even if IPC throws
    act(() => result.current[1]("dark"));
    expect(result.current[0]).toBe("dark");
  });
});
