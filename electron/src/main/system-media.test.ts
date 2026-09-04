import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: electronMocks.handle } }));

import type { ElectronConfigStore } from '../psb/store';
import { registerSystemMediaIpcHandlers, SystemMediaController } from './system-media';

function memoryStore(initial: Record<string, unknown> = {}): ElectronConfigStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as unknown as ElectronConfigStore;
}

describe('SystemMediaController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    electronMocks.handle.mockReset();
  });

  it('does not inspect media when the setting is disabled', async () => {
    const run = vi.fn();
    const controller = new SystemMediaController(memoryStore(), 'darwin', run, null);

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(controller.getEnabled()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('pauses once and resumes only the macOS apps returned by pause', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('paused\n')
      .mockResolvedValueOnce('paused\n')
      .mockResolvedValueOnce('resumed\n')
      .mockResolvedValueOnce('');
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      null,
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[0][0]).toBe('/usr/bin/osascript');
  });

  it('pauses and restores the same macOS Now Playing media through media-control', async () => {
    const media = {
      bundleIdentifier: 'cn.aqzscn.streamMusic',
      processIdentifier: 913,
      title: '定玄',
      artist: '祖娅纳惜',
      album: '定玄',
    };
    const playing = JSON.stringify({
      ...media,
      playing: true,
    });
    const paused = JSON.stringify({ ...media, playing: false });
    const run = vi.fn()
      .mockResolvedValueOnce(playing)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce('');
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      '/test/media-control',
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['get', '--no-artwork'],
      ['pause'],
      ['get', '--no-artwork'],
      ['get', '--no-artwork'],
      ['play'],
    ]);
  });

  it('does not start media that was already paused on macOS', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      bundleIdentifier: 'cn.aqzscn.streamMusic',
      processIdentifier: 913,
      title: '定玄',
      artist: '祖娅纳惜',
      album: '定玄',
      playing: false,
    }));
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      '/test/media-control',
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith('/test/media-control', ['get', '--no-artwork']);
  });

  it('does not resume a different macOS track', async () => {
    const base = {
      bundleIdentifier: 'cn.aqzscn.streamMusic',
      processIdentifier: 913,
      artist: '祖娅纳惜',
      album: '定玄',
    };
    const run = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ ...base, title: '定玄', playing: true }))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ ...base, title: '定玄', playing: false }))
      .mockResolvedValueOnce(JSON.stringify({ ...base, title: '另一首歌', playing: false }));
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      '/test/media-control',
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['get', '--no-artwork'],
      ['pause'],
      ['get', '--no-artwork'],
      ['get', '--no-artwork'],
    ]);
  });

  it('tracks the media that was actually paused after a Now Playing switch', async () => {
    const base = {
      bundleIdentifier: 'cn.aqzscn.streamMusic',
      processIdentifier: 913,
      artist: '祖娅纳惜',
      album: '定玄',
    };
    const first = JSON.stringify({ ...base, title: '第一首', playing: true });
    const actualPaused = JSON.stringify({ ...base, title: '第二首', playing: false });
    const run = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(actualPaused)
      .mockResolvedValueOnce(actualPaused)
      .mockResolvedValueOnce('');
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      '/test/media-control',
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(run.mock.calls.at(-1)?.[1]).toEqual(['play']);
  });

  it('does not restore media when a new playback lease arrives', async () => {
    const media = {
      bundleIdentifier: 'cn.aqzscn.streamMusic',
      processIdentifier: 913,
      title: '定玄',
      artist: '祖娅纳惜',
      album: '定玄',
    };
    const playing = JSON.stringify({ ...media, playing: true });
    const paused = JSON.stringify({ ...media, playing: false });
    let resolveResumeQuery: ((value: string) => void) | null = null;
    const run = vi.fn()
      .mockResolvedValueOnce(playing)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(paused)
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveResumeQuery = resolve;
      }));
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      '/test/media-control',
    );

    await controller.setTtsActive(1, true);
    const restoring = controller.setTtsActive(1, false);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
    const activeAgain = controller.setTtsActive(2, true);
    resolveResumeQuery?.(paused);
    await restoring;
    await activeAgain;

    expect(run.mock.calls.some((call) => call[1][0] === 'play')).toBe(false);
  });

  it('reports the active platform support level', async () => {
    const supported = new SystemMediaController(
      memoryStore(),
      'darwin',
      vi.fn().mockResolvedValue(''),
      '/test/media-control',
    );
    const broken = new SystemMediaController(
      memoryStore(),
      'darwin',
      vi.fn().mockRejectedValue(new Error('unsupported')),
      '/test/media-control',
    );
    await expect(supported.getSupport()).resolves.toBe('system');
    await expect(broken.getSupport()).resolves.toBe('limited');
    await expect(new SystemMediaController(memoryStore(), 'darwin', vi.fn(), null).getSupport())
      .resolves.toBe('limited');
    await expect(new SystemMediaController(memoryStore(), 'linux', vi.fn(), null).getSupport())
      .resolves.toBe('unavailable');
  });

  it('restores paused media immediately when the setting is disabled', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('paused')
      .mockResolvedValueOnce('');
    const store = memoryStore({ 'tts.pauseSystemMedia': true });
    const controller = new SystemMediaController(store, 'darwin', run, null);

    await controller.setTtsActive(1, true);
    await controller.setEnabled(false);

    expect(controller.getEnabled()).toBe(false);
    expect(store.get('tts.pauseSystemMedia')).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('uses encoded PowerShell commands on Windows', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('"Spotify.exe"')
      .mockResolvedValueOnce('');
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'win32',
      run,
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toBe('powershell.exe');
    expect(run.mock.calls[0][1]).toContain('-EncodedCommand');
  });

  it('keeps TTS control calls non-fatal when platform control fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValue(new Error('permission denied'));
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      null,
    );

    await expect(controller.setTtsActive(1, true)).resolves.toBeUndefined();
    await expect(controller.setTtsActive(1, false)).resolves.toBeUndefined();
  });

  it('keeps earlier macOS pause results when a later app fails', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('paused')
      .mockRejectedValueOnce(new Error('Spotify denied'))
      .mockResolvedValueOnce('resumed');
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      null,
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);

    expect(run).toHaveBeenCalledTimes(3);
  });

  it('retries a failed restore without dropping its token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const run = vi.fn()
      .mockResolvedValueOnce('paused')
      .mockResolvedValueOnce('skipped')
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('resumed');
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      null,
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(1, false);
    await controller.setTtsActive(1, false);

    expect(run).toHaveBeenCalledTimes(5);
  });

  it('keeps media paused until every renderer source is inactive', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('paused')
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('resumed');
    const controller = new SystemMediaController(
      memoryStore({ 'tts.pauseSystemMedia': true }),
      'darwin',
      run,
      null,
    );

    await controller.setTtsActive(1, true);
    await controller.setTtsActive(2, true);
    await controller.setTtsActive(1, false);
    expect(run).toHaveBeenCalledTimes(2);
    await controller.setTtsActive(2, false);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('releases a renderer lease when its process exits', async () => {
    const controller = registerSystemMediaIpcHandlers(memoryStore());
    const setTtsActive = vi.spyOn(controller, 'setTtsActive');
    const registration = electronMocks.handle.mock.calls.find(
      ([channel]) => channel === 'system-media:set-tts-active',
    );
    const handler = registration?.[1] as (
      event: { sender: EventEmitter & { id: number } },
      active: boolean,
    ) => Promise<void>;
    const sender = Object.assign(new EventEmitter(), { id: 42 });

    await handler({ sender }, true);
    sender.emit('render-process-gone');
    await Promise.resolve();

    expect(setTtsActive).toHaveBeenNthCalledWith(1, 42, true);
    expect(setTtsActive).toHaveBeenNthCalledWith(2, 42, false);
  });
});
