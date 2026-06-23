import type { PsbOpenConfig } from './types';

export type PsbOpenValidation =
  | { ok: true; value: PsbOpenConfig }
  | { ok: false; error: string };

export function validatePsbOpenConfig(config: unknown): PsbOpenValidation {
  if (!config || typeof config !== 'object') {
    return { ok: false as const, error: 'invalid_config' };
  }
  const raw = config as Record<string, unknown>;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) {
    return { ok: false as const, error: 'missing_url' };
  }
  const width =
    typeof raw.width === 'number' ? Math.max(240, Math.min(2400, Math.floor(raw.width))) : undefined;
  const height =
    typeof raw.height === 'number' ? Math.max(240, Math.min(2400, Math.floor(raw.height))) : undefined;
  const token = typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : undefined;
  const modelId =
    typeof raw.modelId === 'string' && raw.modelId.trim() ? raw.modelId.trim() : undefined;
  return {
    ok: true as const,
    value: { url, token, modelId, width, height },
  };
}

export function isPsbUploadFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.psb') || lower.endsWith('.emtbytes');
}
