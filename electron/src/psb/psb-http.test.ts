/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));

type PsbHttpApi = {
  fetchJson: (path: string, token?: string) => Promise<unknown>;
};

function loadPsbHttp(fetchImpl: typeof fetch): PsbHttpApi {
  const source = readFileSync(
    path.join(here, '../../../nanobot/web/psb/psb-http.js'),
    'utf8',
  );
  const context: Record<string, unknown> = {
    fetch: fetchImpl,
    URL,
    window: {
      location: {
        origin: 'http://127.0.0.1:8765',
      },
    } as Record<string, unknown>,
  };
  vm.runInNewContext(source, context);
  return (context.window as { PsbHttp: PsbHttpApi }).PsbHttp;
}

describe('psb-http', () => {
  it('uses plain-text error bodies instead of parsing them as JSON', async () => {
    const api = loadPsbHttp(
      vi.fn(async () => ({
        ok: false,
        status: 400,
        headers: { get: () => 'text/plain; charset=utf-8' },
        text: async () => 'initial timeline must be a looping timeline',
      })) as unknown as typeof fetch,
    );

    await expect(api.fetchJson('/api/test')).rejects.toThrow(
      'initial timeline must be a looping timeline',
    );
  });
});
