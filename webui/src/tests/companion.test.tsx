import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClientProvider } from "@/providers/ClientProvider";
import { CompanionSettings, clampCompanionPanel, pickCompanionVideo } from "@/providers/CompanionProvider";
import { NanobotClient } from "@/lib/nanobot-client";
import type { CompanionPrefs } from "@/lib/runtime";

afterEach(() => { delete window.nanobotHost; vi.restoreAllMocks(); });

it.each([false, true])('cancels obsolete work video when returning idle (loaded=%s)', async (loaded) => {
  const prefs: CompanionPrefs = { enabled: true, directory: '', schedule: { sunrise: '05:00', day: '10:00', sunset: '18:00', night: '22:00' }, panel: { x: null, y: null, width: 288, collapsed: false } };
  window.nanobotHost = { companion: { read: async () => prefs, save: async () => prefs, choose: async () => null,
    videos: async () => ({ idle: ['idle.mp4'], working: ['work.mp4'], fallback: { idle: ['idle.mp4'], working: ['work.mp4'] }, segment: 'day', error: false }) } };
  const client = new NanobotClient({ url: 'ws://unused', reconnect: false });
  let state!: (working: boolean) => void;
  vi.spyOn(client, 'onCompanionState').mockImplementation(handler => { state = handler; return () => {}; });
  const view = render(<ClientProvider client={client} token="test">chat</ClientProvider>);
  const { act } = await import('@testing-library/react');
  await waitFor(() => expect(view.container.querySelector('video[src="idle.mp4"]')).not.toBeNull());
  const originalIdle = view.container.querySelector('video[src="idle.mp4"]')!;
  fireEvent.loadedData(originalIdle);
  act(() => state(true));
  await waitFor(() => expect(view.container.querySelector('video[src="work.mp4"]')).not.toBeNull());
  const obsoleteWork = view.container.querySelector('video[src="work.mp4"]')!;
  if (loaded) fireEvent.loadedData(obsoleteWork);
  act(() => state(false));
  const idle = view.container.querySelector('video[src="idle.mp4"]')!;
  if (loaded) { expect(idle).not.toBe(originalIdle); fireEvent.loadedData(idle); }
  else fireEvent.loadedData(obsoleteWork);
  expect(idle).toHaveClass('opacity-100');
  expect(view.container.querySelector('video[src="work.mp4"].opacity-100')).toBeNull();
  view.unmount();
});

it('keeps the panel visible after resize and avoids immediate video repeats', () => {
  const panel = clampCompanionPanel({ x: 3000, y: 3000, width: 1120, collapsed: false }, 760, 540);
  expect(panel.x! + panel.width).toBe(760);
  expect(panel.y! + panel.width * 3 / 4 + 32).toBeLessThanOrEqual(540);
  expect(clampCompanionPanel({ ...panel, x: -100 }, 760, 540).x).toBe(0);
  expect(clampCompanionPanel({ ...panel, x: 0 }, 760, 540, 240).x).toBe(240);
  const wide = clampCompanionPanel({ x: 0, y: 38, width: 320, collapsed: false }, 760, 540, 0, 16 / 9);
  expect(wide.y! + wide.width / (16 / 9) + 32).toBeLessThanOrEqual(540);
  expect(pickCompanionVideo(['a', 'b', 'c'], ['a', 'b'], 'b')).toBe('c');
});

it('loads local videos, switches only idle/working, and persists collapse/disable', async () => {
  let prefs: CompanionPrefs = { enabled: true, directory: '', schedule: { sunrise: '05:00', day: '10:00', sunset: '18:00', night: '22:00' }, panel: { x: null, y: null, width: 288, collapsed: false } };
  const api = { read: vi.fn(async () => prefs), save: vi.fn(async (patch: Partial<CompanionPrefs>) => (prefs = { ...prefs, ...patch })), choose: vi.fn(),
    videos: vi.fn(async () => ({ idle: ['idle.mp4'], working: ['work.mp4'], fallback: { idle: ['fallback.mp4', 'other.mp4'], working: ['work.mp4'] }, segment: 'day', error: false })) };
  window.nanobotHost = { companion: api };
  const client = new NanobotClient({ url: 'ws://unused', reconnect: false });
  let run!: (id: string, time: number | null) => void;
  vi.spyOn(client, 'onRunStatus').mockImplementation(handler => { run = handler; return () => {}; });
  const view = render(<ClientProvider client={client} token="test"><CompanionSettings /></ClientProvider>);
  await waitFor(() => expect(view.container.querySelector('video')).toHaveAttribute('src', 'idle.mp4'));
  const firstVideo = view.container.querySelector('video')!;
  Object.defineProperties(firstVideo, {
    videoWidth: { configurable: true, value: 1120 },
    videoHeight: { configurable: true, value: 832 },
  });
  fireEvent.loadedData(firstVideo);
  await waitFor(() => expect(Number.parseFloat(
    (view.container.querySelector('.companion-panel') as HTMLElement)
      .style.getPropertyValue('--companion-aspect-ratio'),
  )).toBeCloseTo(1120 / 832));
  expect(view.container.querySelector('.companion-panel-header')).toHaveClass('bg-background/90', 'backdrop-blur');
  const resizeHandles = view.container.querySelectorAll('button[data-resize-edge]');
  expect(Array.from(resizeHandles).map(button => button.getAttribute('data-resize-edge')))
    .toEqual(['left', 'right']);
  expect(Array.from(resizeHandles).every(button => !button.hasAttribute('title') && button.childElementCount === 0)).toBe(true);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  fireEvent.error(view.container.querySelector('video')!);
  await waitFor(() => expect(view.container.querySelector('video[src="fallback.mp4"]')).not.toBeNull());
  expect(view.container.querySelector('video[src="fallback.mp4"]')).not.toHaveAttribute('loop');
  const { act } = await import('@testing-library/react');
  act(() => run('desktop', 10));
  await waitFor(() => expect(view.container.querySelector('video[src="work.mp4"]')).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  await waitFor(() => expect(view.container.querySelector('video')).toBeNull());
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ panel: expect.objectContaining({ collapsed: true }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull());
  expect(prefs.enabled).toBe(false);
});
