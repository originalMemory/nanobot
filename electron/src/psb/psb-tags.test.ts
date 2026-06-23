/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

import {
  formatAssistantContentForDisplay,
  parsePsbTags,
  stripPsbTags,
} from './psb-tags';
import { sendPsbRuntimeAction, syncNewPsbTags } from './tag-sync';

describe('parsePsbTags', () => {
  it('parses timeline and face tags', () => {
    const text = '<psb:timeline name="待机" /><psb:face var="face_mouth" value="0.5" />你好';
    expect(parsePsbTags(text)).toEqual([
      { type: 'timeline', payload: { name: '待机' } },
      { type: 'face', payload: { var: 'face_mouth', value: '0.5' } },
    ]);
  });

  it('ignores malformed tags', () => {
    expect(parsePsbTags('<psb:face var="x" />')).toEqual([]);
  });
});

describe('stripPsbTags', () => {
  it('removes tags but keeps prose', () => {
    expect(stripPsbTags('<psb:timeline name="待机" />你好')).toBe('你好');
  });
});

describe('formatAssistantContentForDisplay', () => {
  it('hides tags when showResponseTags is false', () => {
    const raw = '<psb:timeline name="待机" />你好';
    expect(formatAssistantContentForDisplay(raw, false)).toBe('你好');
    expect(formatAssistantContentForDisplay(raw, true)).toBe(raw);
  });
});

describe('syncNewPsbTags', () => {
  it('forwards only new actions', () => {
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', {
      electronAPI: { psb: { sendAction } },
    });
    const text = '<psb:timeline name="待机" /><psb:expression name="微笑" />';
    expect(syncNewPsbTags(text, 0)).toBe(2);
    expect(sendAction).toHaveBeenCalledTimes(2);
    expect(syncNewPsbTags(text, 2)).toBe(2);
    expect(sendAction).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe('sendPsbRuntimeAction', () => {
  it('no-ops without electron API', () => {
    vi.stubGlobal('window', {});
    expect(() => sendPsbRuntimeAction({ type: 'stream-end' })).not.toThrow();
    vi.unstubAllGlobals();
  });
});
