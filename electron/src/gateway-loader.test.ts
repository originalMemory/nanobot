import { describe, expect, it, vi } from 'vitest';

import {
  createGatewayRendererLoader,
  gatewayRetryDelayMs,
} from './gateway-loader';

describe('gateway renderer loader', () => {
  it('retries a failed initial load and recovers', async () => {
    const loadURL = vi.fn()
      .mockRejectedValueOnce(new Error('gateway not ready'))
      .mockResolvedValue(undefined);
    const scheduled: Array<() => void> = [];
    const schedule = vi.fn((callback: () => void) => {
      scheduled.push(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const loader = createGatewayRendererLoader(
      { isDestroyed: () => false, loadURL },
      () => 'http://127.0.0.1:8765/',
      schedule,
    );

    loader.start();
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith(expect.any(Function), 500));
    scheduled.shift()?.();
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledTimes(2));
  });

  it('cancels a pending retry when the window closes', async () => {
    const cancel = vi.fn();
    const schedule = vi.fn(() => 7 as unknown as ReturnType<typeof setTimeout>);
    const loader = createGatewayRendererLoader(
      {
        isDestroyed: () => false,
        loadURL: vi.fn().mockRejectedValue(new Error('gateway not ready')),
      },
      () => 'http://127.0.0.1:8765/',
      schedule,
      cancel,
    );

    loader.start();
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    loader.stop();

    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('reloads immediately with a changed gateway URL', async () => {
    let url = 'http://127.0.0.1:8765/';
    const loadURL = vi.fn().mockRejectedValueOnce(new Error('gateway not ready'));
    const cancel = vi.fn();
    const schedule = vi.fn(() => 9 as unknown as ReturnType<typeof setTimeout>);
    const onFailure = vi.fn();
    const loader = createGatewayRendererLoader(
      { isDestroyed: () => false, loadURL },
      () => url,
      schedule,
      cancel,
      onFailure,
    );

    loader.start();
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    expect(onFailure).toHaveBeenCalledOnce();

    url = 'https://nanobot.example.com/';
    loader.reload();
    await vi.waitFor(() => expect(loadURL).toHaveBeenLastCalledWith(url));
    expect(cancel).toHaveBeenCalledWith(9);
  });

  it('caps exponential retry delays', () => {
    expect(gatewayRetryDelayMs(0)).toBe(500);
    expect(gatewayRetryDelayMs(3)).toBe(4_000);
    expect(gatewayRetryDelayMs(20)).toBe(10_000);
  });
});
