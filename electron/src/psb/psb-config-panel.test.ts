/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadPsbConfigPanel() {
  const source = readFileSync(
    path.join(here, '../../../nanobot/web/psb/psb-config-panel.js'),
    'utf8',
  );
  const context: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: {
      getElementById: () => null,
    },
  };
  vm.runInNewContext(source, context);
  return context.window as { PsbConfigPanel?: { isOpen: () => boolean } };
}

describe('psb-config-panel', () => {
  it('exposes PsbConfigPanel API', () => {
    const win = loadPsbConfigPanel();
    expect(win.PsbConfigPanel).toBeTruthy();
    expect(win.PsbConfigPanel?.isOpen()).toBe(false);
  });
});
