import { afterEach, expect, it, vi } from "vitest";
import { isSpeechEvent, SpeechPlayer } from "@/lib/speech";

afterEach(() => vi.unstubAllGlobals());

it("validates wire chunks and restores media after streaming drains", async () => {
  const event = { event: "speech" as const, chat_id: "desktop", turn_id: "one" };
  expect(isSpeechEvent({ ...event, phase: "chunk", pcm: "", sequence: -1 })).toBe(false);
  const sources: { onended: (() => void) | null; stop: () => void; start: () => void }[] = [];
  const samples: Float32Array[] = [];
  class Context {
    state = "running"; currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
    createBuffer(_channels: number, count: number) {
      const values = new Float32Array(count); samples.push(values);
      return { duration: count / 24000, getChannelData: () => values };
    }
    createBufferSource() {
      const source = { onended: null, stop: vi.fn(), start: vi.fn(), connect: vi.fn() };
      sources.push(source); return source;
    }
  }
  vi.stubGlobal("AudioContext", Context);
  const host = { active: vi.fn(async () => {}), settings: vi.fn() };
  const changed = vi.fn();
  const player = new SpeechPlayer(host, changed);
  player.receive({ ...event, phase: "start" });
  for (let sequence = 0; sequence < 10; sequence++) {
    player.receive({ ...event, phase: "chunk", pcm: btoa("\x00\x40\x00\xC0"), sequence });
  }
  player.receive({ ...event, phase: "end" });
  await vi.waitFor(() => expect(sources).toHaveLength(10));
  expect([...samples[0]]).toEqual([0.5, -0.5]);
  expect(host.active).toHaveBeenLastCalledWith(true);
  expect(host.active).toHaveBeenCalledTimes(1);
  for (const source of sources) source.onended?.();
  await vi.waitFor(() => expect(host.active).toHaveBeenLastCalledWith(false));
  player.stop();
  await Promise.resolve();
  expect(host.active.mock.calls.map((call) => call[0])).toEqual([true, false]);
});

it("stop prevents delayed pause completion from resurrecting audio", async () => {
  let release!: () => void;
  const start = vi.fn();
  vi.stubGlobal("AudioContext", class {
    state = "running"; currentTime = 0;
    resume = async () => {};
    close = async () => {};
    createBufferSource = () => ({ start });
  });
  const host = { active: vi.fn((active: boolean) => active ? new Promise<void>((r) => { release = r; }) : Promise.resolve()), settings: vi.fn() };
  const player = new SpeechPlayer(host, vi.fn());
  const event = { event: "speech" as const, chat_id: "desktop", turn_id: "one" };
  player.receive({ ...event, phase: "start" });
  player.receive({ ...event, phase: "chunk", pcm: "AAA=", sequence: 0 });
  await vi.waitFor(() => expect(release).toBeDefined());
  player.stop(); release();
  await Promise.resolve(); await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(host.active).toHaveBeenLastCalledWith(false));
});

it("a new live response supersedes a replay waiting for media pause", async () => {
  let release!: () => void;
  const play = vi.fn(async () => {});
  vi.stubGlobal("Audio", class { play = play; pause = vi.fn(); });
  const host = { active: vi.fn((active: boolean) => active ? new Promise<void>((r) => { release = r; }) : Promise.resolve()), settings: vi.fn() };
  const changed = vi.fn();
  const player = new SpeechPlayer(host, changed);
  const pending = player.replay("old", "/media/old.wav");
  player.receive({ event: "speech", chat_id: "desktop", turn_id: "new", phase: "start" });
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith("new"));
  release(); await pending;
  expect(play).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith("new");
  player.stop();
});
