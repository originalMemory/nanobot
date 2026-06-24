/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));

function createSelect(initial = 'face_mouth') {
  let value = initial;
  const listeners: Array<() => void> = [];
  return {
    get value() {
      return value;
    },
    set value(next: string) {
      value = next;
    },
    innerHTML: '',
    appendChild(opt: { value: string; textContent: string }) {
      void opt;
    },
    addEventListener: (_type: string, handler: () => void) => {
      listeners.push(handler);
    },
    dispatchChange() {
      listeners.forEach((handler) => handler());
    },
  };
}

function loadPsbConfigPanelWithFaceMocks(selectedLabel = 'face_mouth') {
  const faceSelect = createSelect(selectedLabel);
  const frameLabels: string[] = [];
  const framesContainer = {
    innerHTML: '',
    _slider: null as unknown,
    appendChild(node: { className?: string; textContent?: string }) {
      if (node.className === 'cfg-frame-btn') {
        frameLabels.push(node.textContent || '');
      }
    },
    querySelectorAll: () => [],
  };

  const source = readFileSync(
    path.join(here, '../../../nanobot/web/psb/psb-config-panel.js'),
    'utf8',
  );
  const context: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: {
      getElementById: (id: string) => {
        if (id === 'cfg-face-select') return faceSelect;
        if (id === 'cfg-face-frames') return framesContainer;
        return null;
      },
      createElement: (tag: string) => {
        if (tag === 'button') {
          return {
            type: 'button',
            className: '',
            dataset: {} as Record<string, string>,
            textContent: '',
            title: '',
            addEventListener: () => undefined,
          };
        }
        if (tag === 'span') {
          return { className: '', textContent: '' };
        }
        return { textContent: '', appendChild: () => undefined };
      },
    },
  };
  vm.runInNewContext(source, context);
  const panel = (context.window as { PsbConfigPanel?: PanelApi }).PsbConfigPanel;
  return { panel, faceSelect, frameLabels };
}

type PanelApi = {
  init: (options: Record<string, unknown>) => void;
  refresh: () => void;
};

const faceMetadata = {
  timelines: [],
  expressions: [],
  faceVariables: [
    {
      label: 'face_mouth',
      labelZh: '嘴',
      frames: [
        { label: '閉じ', labelZh: '闭上', value: 0 },
        { label: '開き', labelZh: '张开', value: 1 },
      ],
    },
    {
      label: 'face_eye',
      labelZh: '眼',
      frames: [
        { label: '通常', labelZh: '通常', value: 0 },
        { label: '閉じ', labelZh: '闭上', value: 1 },
      ],
    },
  ],
  fadeVariables: [],
};

describe('psb-config-panel face select', () => {
  it('keeps selected part and refreshes frame buttons on change', () => {
    const { panel, faceSelect, frameLabels } = loadPsbConfigPanelWithFaceMocks('face_mouth');
    panel?.init({
      getModelMetadata: () => faceMetadata,
      getSavedInitialState: () => ({ timeline: '', expression: '', face: {}, fade: {} }),
      applyVariableMap: () => undefined,
    });
    panel?.refresh();
    expect(faceSelect.value).toBe('face_mouth');
    expect(frameLabels).toEqual(['闭上', '张开']);

    faceSelect.value = 'face_eye';
    frameLabels.length = 0;
    faceSelect.dispatchChange();

    expect(faceSelect.value).toBe('face_eye');
    expect(frameLabels).toEqual(['通常', '闭上']);
  });
});
