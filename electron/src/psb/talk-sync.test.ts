/**
 * @vitest-environment node
 */
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type EmoteTalkSync = {
  measureAmplitude: (
    analyser: { frequencyBinCount: number; getByteFrequencyData: (data: Uint8Array) => void },
    sampleRate: number,
    now: number,
  ) => number;
};

function loadTalkSync(): EmoteTalkSync {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, '../../../nanobot/web/psb/talk-sync.js'), 'utf8');
  const sandbox: { window: { EmoteTalkSync?: EmoteTalkSync } } = { window: {} };
  runInContext(source, createContext(sandbox));
  if (!sandbox.window.EmoteTalkSync) {
    throw new Error('EmoteTalkSync not exported');
  }
  return sandbox.window.EmoteTalkSync;
}

const talkSync = loadTalkSync();

describe('EmoteTalkSync.measureAmplitude', () => {
  it('returns zero below noise gate', () => {
    const data = new Uint8Array(256);
    const analyser = {
      frequencyBinCount: data.length,
      getByteFrequencyData: (target: Uint8Array) => {
        target.set(data);
      },
    };
    expect(talkSync.measureAmplitude(analyser, 48000, 0)).toBe(0);
  });

  it('returns positive amplitude for vocal band energy', () => {
    const data = new Uint8Array(256);
    for (let i = 20; i < 80; i += 1) data[i] = 80;
    const analyser = {
      frequencyBinCount: data.length,
      getByteFrequencyData: (target: Uint8Array) => {
        target.set(data);
      },
    };
    expect(talkSync.measureAmplitude(analyser, 48000, 1000)).toBeGreaterThan(0);
  });
});
