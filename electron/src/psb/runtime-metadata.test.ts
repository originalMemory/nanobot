/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadRuntimeMetadata() {
  const source = readFileSync(
    path.join(here, '../../../nanobot/web/psb/psb-runtime-metadata.js'),
    'utf8',
  );
  const context: Record<string, unknown> = { window: {} as Record<string, unknown> };
  vm.runInNewContext(source, context);
  return (context.window as { PsbRuntimeMetadata: RuntimeApi }).PsbRuntimeMetadata;
}

type RuntimeApi = {
  extract: (
    player: {
      initialized: boolean;
      mainTimelineLabels: string[];
      isLoopTimeline: (label: string) => boolean;
      touchVariableList: () => void;
      touchMainTimelineLabels: () => void;
      variableList: Array<{
        label: string;
        minValue: number;
        maxValue: number;
        frameList: Array<{ label: string; value: number }>;
      }>;
    },
    serverMeta: Record<string, unknown>,
  ) => {
    timelines: Array<{ label: string; labelZh: string; looping: boolean }>;
    expressions: Array<{ label: string }>;
    faceVariables: Array<{ label: string }>;
  };
};

describe('psb-runtime-metadata', () => {
  it('extracts timelines and expressions from player', () => {
    const api = loadRuntimeMetadata();
    const player = {
      initialized: true,
      mainTimelineLabels: ['待機', '走る'],
      isLoopTimeline: (label: string) => label === '待機',
      touchVariableList: () => undefined,
      touchMainTimelineLabels: () => undefined,
      variableList: [
        {
          label: 'face_mouth',
          minValue: 0,
          maxValue: 1,
          frameList: [
            { label: '閉じ', value: 0 },
            { label: '通常', value: 0.5 },
          ],
        },
      ],
    };

    const caps = api.extract(player, {
      timelines: [{ label: '待機', labelZh: '待机', looping: true }],
    });

    expect(caps.timelines).toHaveLength(2);
    expect(caps.timelines[0]).toMatchObject({ label: '待機', labelZh: '待机', looping: true });
    expect(caps.expressions.length).toBeGreaterThan(0);
    expect(caps.faceVariables[0].label).toBe('face_mouth');
  });

  it('exposes Chinese fade slot hints for standard E-mote variables', () => {
    const api = loadRuntimeMetadata() as RuntimeApi & {
      fadeHintZh: (label: string) => string;
    };
    expect(api.fadeHintZh('fade_w')).toContain('鼓脸');
    expect(api.fadeHintZh('fade_x')).toContain('害羞');
    expect(api.fadeHintZh('fade_unknown')).toBe('');
  });

  it('splits compact runtime payload into multiple GET-safe chunks', () => {
    const api = loadRuntimeMetadata() as RuntimeApi & {
      compactForServerSync: (runtimeCaps: Record<string, unknown>) => Record<string, unknown>;
      splitCompactForServerSync: (compact: Record<string, unknown>) => Array<Record<string, unknown>>;
    };
    const compact = api.compactForServerSync({
      timelines: [{ label: '待機', looping: true }],
      expressions: [{ label: '通常' }],
      faceVariables: Array.from({ length: 11 }, (_, index) => ({
        label: `face_${index}`,
        minValue: 0,
        maxValue: 1,
      })),
      fadeVariables: Array.from({ length: 13 }, (_, index) => ({
        label: `fade_${index}`,
        minValue: 0,
        maxValue: 1,
      })),
      hasFaceTalk: true,
    });
    const chunks = api.splitCompactForServerSync(compact);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.some((chunk) => Array.isArray(chunk.timelines) && chunk.timelines.length === 1)).toBe(true);
    expect(chunks.some((chunk) => chunk.hasFaceTalk === true)).toBe(true);
    expect(chunks.every((chunk) => !chunk.timelines || chunk.timelines.length <= 4)).toBe(true);
    const fadeCount = chunks.reduce(
      (total, chunk) => total + ((chunk.fadeVariables as unknown[]) || []).length,
      0,
    );
    expect(fadeCount).toBe(13);
  });

  it('splits long Japanese timeline lists without combining expressions', () => {
    const api = loadRuntimeMetadata() as RuntimeApi & {
      compactForServerSync: (runtimeCaps: Record<string, unknown>) => Record<string, unknown>;
      splitCompactForServerSync: (compact: Record<string, unknown>) => Array<Record<string, unknown>>;
    };
    const labels = [
      '待機',
      'おさんぽ',
      'はい_遅',
      'はい',
      'はい_速',
      'うんうん',
      'いいえ',
      'ありがとう',
      '首かしげ',
      'ん？',
      '驚き',
      '考える',
      '上目遣い',
      '微笑み',
      'もじもじ',
      '嬉しい',
    ];
    const compact = api.compactForServerSync({
      timelines: labels.map((label) => ({ label, looping: true })),
      expressions: [
        { label: '通常' },
        { label: '怒' },
        { label: '笑' },
        { label: 'びっくり' },
      ],
      hasFaceTalk: true,
    });
    const chunks = api.splitCompactForServerSync(compact);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((chunk) => !(chunk.timelines && chunk.expressions))).toBe(true);
    const timelineCount = chunks.reduce(
      (total, chunk) => total + ((chunk.timelines as unknown[]) || []).length,
      0,
    );
    expect(timelineCount).toBe(16);
  });
});
