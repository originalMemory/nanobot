export interface RendererLoadTarget {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
}

export interface GatewayRendererLoader {
  start(): void;
  reload(): void;
  stop(): void;
}

export function gatewayRetryDelayMs(attempt: number): number {
  return Math.min(500 * (2 ** Math.max(0, attempt)), 10_000);
}

export function createGatewayRendererLoader(
  target: RendererLoadTarget,
  getUrl: () => string,
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
  onFailure?: (error: unknown) => void,
): GatewayRendererLoader {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const load = async () => {
    if (stopped || target.isDestroyed()) return;
    try {
      await target.loadURL(getUrl());
      attempt = 0;
    } catch (error) {
      if (stopped || target.isDestroyed()) return;
      onFailure?.(error);
      const delay = gatewayRetryDelayMs(attempt);
      attempt += 1;
      timer = schedule(() => {
        timer = null;
        void load();
      }, delay);
    }
  };

  return {
    start() {
      stopped = false;
      void load();
    },
    reload() {
      stopped = false;
      attempt = 0;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      void load();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
  };
}
