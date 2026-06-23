/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { shouldAutoOpenPsb } from './auto-show';
import { validatePsbOpenConfig, isPsbUploadFilename } from './validate';

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
