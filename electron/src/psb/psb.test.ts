/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { shouldAutoOpenPsb } from './auto-show';
import { clampPsbOpacity, clampPsbWindowSize, writePsbWindowState } from './store';
import { validatePsbOpenConfig, isPsbUploadFilename } from './validate';

describe('clampPsbWindowSize', () => {
  it('clamps to 240-2400', () => {
    expect(clampPsbWindowSize(100)).toBe(240);
    expect(clampPsbWindowSize(9999)).toBe(2400);
    expect(clampPsbWindowSize(480.9)).toBe(480);
  });
});

describe('clampPsbOpacity', () => {
  it('clamps to 0.2-1', () => {
    expect(clampPsbOpacity(0)).toBe(0.2);
    expect(clampPsbOpacity(2)).toBe(1);
    expect(clampPsbOpacity(0.456)).toBe(0.46);
  });
});

describe('writePsbWindowState', () => {
  it('persists clamped width, height, and opacity', () => {
    const data: Record<string, unknown> = {};
    const store = {
      get: (key: string) => data[key],
      set: (key: string, value: unknown) => {
        data[key] = value;
      },
    };
    const next = writePsbWindowState(store, { width: 9999, height: 100, opacity: 0.05 });
    expect(next.width).toBe(2400);
    expect(next.height).toBe(240);
    expect(next.opacity).toBe(0.2);
  });
});

describe('validatePsbOpenConfig', () => {
  it('rejects missing url', () => {
    expect(validatePsbOpenConfig(null)).toEqual({ ok: false, error: 'invalid_config' });
    expect(validatePsbOpenConfig({})).toEqual({ ok: false, error: 'missing_url' });
    expect(validatePsbOpenConfig({ url: '  ' })).toEqual({ ok: false, error: 'missing_url' });
  });

  it('accepts valid config and clamps size', () => {
    const result = validatePsbOpenConfig({
      url: 'http://127.0.0.1:8765/',
      token: 'tok',
      modelId: 'demo',
      width: 9999,
      height: 100,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.width).toBe(2400);
      expect(result.value.height).toBe(240);
    }
  });
});

describe('isPsbUploadFilename', () => {
  it('accepts psb and emtbytes only', () => {
    expect(isPsbUploadFilename('a.psb')).toBe(true);
    expect(isPsbUploadFilename('a.emtbytes')).toBe(true);
    expect(isPsbUploadFilename('a.json')).toBe(false);
  });
});

describe('shouldAutoOpenPsb', () => {
  it('opens when autoShow and compatible model selected', () => {
    expect(
      shouldAutoOpenPsb(
        {
          autoShow: true,
          selectedModelId: 'demo',
          models: [{ modelId: 'demo', compatible: true }],
        },
        false,
      ),
    ).toBe(true);
  });

  it('skips when temporarily closed or model incompatible', () => {
    expect(
      shouldAutoOpenPsb(
        {
          autoShow: true,
          selectedModelId: 'demo',
          models: [{ modelId: 'demo', compatible: true }],
        },
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoOpenPsb(
        {
          autoShow: true,
          selectedModelId: 'demo',
          models: [{ modelId: 'demo', compatible: false }],
        },
        false,
      ),
    ).toBe(false);
  });
});
