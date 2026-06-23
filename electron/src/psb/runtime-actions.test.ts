/**
 * @vitest-environment node
 */
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type PsbActions = {
  normalizeAction: (raw: unknown) => { type: string; payload: Record<string, unknown> } | null;
  pickTimelineLabel: (
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => { ok: boolean; label?: string; looping?: boolean; error?: string };
  pickFaceUpdate: (
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => { ok: boolean; label?: string; value?: number; error?: string };
};

function loadPsbActions(): PsbActions {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, '../../../nanobot/web/psb/psb-actions.js'), 'utf8');
  const sandbox: { window: { PsbActions?: PsbActions } } = { window: {} };
  runInContext(source, createContext(sandbox));
  if (!sandbox.window.PsbActions) {
    throw new Error('PsbActions not exported');
  }
  return sandbox.window.PsbActions;
}

const actions = loadPsbActions();

describe('PsbActions', () => {
  it('normalizes runtime action payloads', () => {
    expect(actions.normalizeAction({ type: 'timeline', payload: { name: '待機' } })).toEqual({
      type: 'timeline',
      payload: { name: '待機' },
    });
    expect(actions.normalizeAction(null)).toBeNull();
  });

  it('resolves timeline by label or labelZh', () => {
    const metadata = {
      timelines: [{ label: '待機', labelZh: '待机', looping: true }],
    };
    expect(actions.pickTimelineLabel({ name: '待机' }, metadata)).toEqual({
      ok: true,
      label: '待機',
      looping: true,
    });
  });

  it('rejects unknown face variable when metadata is present', () => {
    const metadata = { faceVariables: [{ label: 'face_mouth' }] };
    expect(actions.pickFaceUpdate({ var: 'face_eye_open', value: 1 }, metadata)).toEqual({
      ok: false,
      error: 'unknown variable: face_eye_open',
    });
  });
});
