/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

import {
  formatAssistantContentForDisplay,
  parsePsbTags,
  stripPsbTags,
} from './psb-tags';
import { sendPsbRuntimeAction, syncNewPsbTags, markMessagesPsbTagsSynced, currentTurnAssistantMessages } from './tag-sync';
import type { UIMessage } from '../renderer/lib/types';

describe('parsePsbTags', () => {
  it('parses timeline and face tags', () => {
    const text = '<psb:timeline name="待机" /><psb:face var="face_mouth" value="0.5" />你好';
    expect(parsePsbTags(text)).toEqual([
      { type: 'timeline', payload: { name: '待机' } },
      { type: 'face', payload: { var: 'face_mouth', value: '0.5' } },
    ]);
  });

  it('parses Japanese timeline and expression tags from assistant replies', () => {
    const text = [
      '好，来试试新技能！<psb:timeline name="おさんぽ" />走走活动一下～<psb:expression name="笑" />',
      '<psb:timeline name="嬉しい" /><psb:face var="face_cheek" value="0.5" />开心！<psb:expression name="通常" />',
      '<psb:timeline name="考える" /><psb:face var="face_eye_UD" value="-30" />嗯…<psb:expression name="" />',
      '<psb:timeline name="微笑み" />怎么样，动起来了吧？',
    ].join('\n\n');
    expect(parsePsbTags(text)).toEqual([
      { type: 'timeline', payload: { name: 'おさんぽ' } },
      { type: 'expression', payload: { name: '笑' } },
      { type: 'timeline', payload: { name: '嬉しい' } },
      { type: 'face', payload: { var: 'face_cheek', value: '0.5' } },
      { type: 'expression', payload: { name: '通常' } },
      { type: 'timeline', payload: { name: '考える' } },
      { type: 'face', payload: { var: 'face_eye_UD', value: '-30' } },
      { type: 'timeline', payload: { name: '微笑み' } },
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
  it('hides psb tags for assistant display', () => {
    const raw = '<psb:timeline name="待机" />你好';
    expect(formatAssistantContentForDisplay(raw)).toBe('你好');
  });
});

describe('syncNewPsbTags', () => {
  it('forwards only new actions when delivery succeeds', async () => {
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', {
      electronAPI: { psb: { sendAction } },
    });
    const text = '<psb:timeline name="待机" /><psb:expression name="微笑" />';
    await expect(syncNewPsbTags(text, 0)).resolves.toBe(2);
    expect(sendAction).toHaveBeenCalledTimes(2);
    await expect(syncNewPsbTags(text, 2)).resolves.toBe(2);
    expect(sendAction).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('stops at the first failed delivery so actions can be retried', async () => {
    const sendAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('window', {
      electronAPI: { psb: { sendAction } },
    });
    const text = '<psb:timeline name="待机" /><psb:expression name="微笑" />';
    await expect(syncNewPsbTags(text, 0)).resolves.toBe(1);
    expect(sendAction).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe('sendPsbRuntimeAction', () => {
  it('no-ops without electron API', async () => {
    vi.stubGlobal('window', {});
    await expect(sendPsbRuntimeAction({ type: 'stream-end' })).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('markMessagesPsbTagsSynced', () => {
  it('marks historical assistant tags without sending actions', async () => {
    const sendAction = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', {
      electronAPI: { psb: { sendAction } },
    });
    const synced = new Map<string, number>();
    const messages: UIMessage[] = [
      {
        id: 'hist-1',
        role: 'assistant',
        content: '<psb:timeline name="待机" />历史',
        createdAt: 1,
      },
    ];
    markMessagesPsbTagsSynced(messages, synced);
    expect(synced.get('hist-1')).toBe(1);
    await expect(syncNewPsbTags(messages[0].content, synced.get('hist-1') ?? 0)).resolves.toBe(1);
    expect(sendAction).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('currentTurnAssistantMessages', () => {
  it('returns only assistant messages after the latest user turn', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', content: 'old', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '<psb:timeline name="待机" />', createdAt: 2 },
      { id: 'u2', role: 'user', content: 'new', createdAt: 3 },
      { id: 'a2', role: 'assistant', content: '<psb:timeline name="おさんぽ" />', createdAt: 4 },
    ];
    expect(currentTurnAssistantMessages(messages).map((m) => m.id)).toEqual(['a2']);
  });
});
