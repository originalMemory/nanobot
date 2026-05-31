import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapTokenExpiresAt,
  tokenRefreshDelayMs,
} from "@/lib/bootstrap";

describe("bootstrapTokenExpiresAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns now plus expires_in seconds", () => {
    expect(bootstrapTokenExpiresAt(300)).toBe(Date.now() + 300_000);
  });

  it("treats negative expires_in as zero", () => {
    expect(bootstrapTokenExpiresAt(-10)).toBe(Date.now());
  });
});

describe("tokenRefreshDelayMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes before expiry with a margin for short-lived tokens", () => {
    const expiresAt = Date.now() + 30_000;
    expect(tokenRefreshDelayMs(expiresAt)).toBe(15_000);
  });

  it("caps margin at TOKEN_REFRESH_MARGIN_MS for long-lived tokens", () => {
    const expiresAt = Date.now() + 300_000;
    expect(tokenRefreshDelayMs(expiresAt)).toBe(270_000);
  });

  it("never schedules below the minimum delay", () => {
    const expiresAt = Date.now() + 3_000;
    expect(tokenRefreshDelayMs(expiresAt)).toBe(5_000);
  });
});
