/**
 * @vitest-environment node
 */
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

type EmoteTalkSync = {
  measureAmplitude: (
    analyser: { frequencyBinCount: number; getByteFrequencyData: (data: Uint8Array) => void },
    sampleRate: number,
    now: number,
  ) => number;
  startPcmStream: (
    sampleRate: number,
    player: Record<string, unknown>,
    onUpdate?: ((value: number) => void) | null,
    onStreamEnd?: (() => void) | null,
  ) => boolean;
  appendPcmChunk: (data: string, sampleRate: number) => boolean;
  endPcmStream: () => void;
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

  it('reports PCM completion only after the final scheduled source ends', () => {
    let sourceEnded: (() => void) | null = null;
    const audioContext = {
      currentTime: 0,
      sampleRate: 24000,
      state: 'running',
      destination: {},
      createAnalyser: () => ({
        frequencyBinCount: 256,
        connect: (): void => undefined,
        disconnect: (): void => undefined,
        getByteFrequencyData: (): void => undefined,
      }),
      createBuffer: (_channels: number, samples: number, sampleRate: number) => ({
        duration: samples / sampleRate,
        getChannelData: (): Float32Array => new Float32Array(samples),
      }),
      createBufferSource: () => ({
        buffer: null as unknown,
        connect: (): void => undefined,
        disconnect: (): void => undefined,
        stop: (): void => undefined,
        start: (): void => undefined,
        set onended(callback: (() => void) | null) {
          sourceEnded = callback;
        },
      }),
    };
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, '../../../nanobot/web/psb/talk-sync.js'), 'utf8');
    const sandbox: Record<string, unknown> & { window: Record<string, unknown> } = {
      window: { AudioContext: class { constructor() { return audioContext; } } },
      requestAnimationFrame: (): number => 1,
      cancelAnimationFrame: (): void => undefined,
      atob,
      Uint8Array,
      Float32Array,
      DataView,
    };
    runInContext(source, createContext(sandbox));
    const runtime = sandbox.window.EmoteTalkSync as EmoteTalkSync;
    const onStreamEnd = vi.fn();
    const player = {
      initialized: true,
      variableList: [{ label: 'face_talk' }],
      setVariable: (): void => undefined,
    };

    expect(runtime.startPcmStream(24000, player, null, onStreamEnd)).toBe(true);
    expect(runtime.appendPcmChunk('AAAAAA==', 24000)).toBe(true);
    runtime.endPcmStream();
    expect(onStreamEnd).not.toHaveBeenCalled();
    sourceEnded?.();
    expect(onStreamEnd).toHaveBeenCalledOnce();
  });
});
