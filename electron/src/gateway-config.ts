export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8765';

export type SetGatewayUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: 'empty' | 'invalid' | 'unsupported' | 'credentials' };

export interface GatewayUrlResolution {
  url: string;
  source: 'cli' | 'env' | 'stored' | 'default';
}

/** 校验并归一化用户明确配置的 Gateway origin。 */
export function normalizeGatewayUrl(raw: string): SetGatewayUrlResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'empty' };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'unsupported' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'credentials' };
  }
  return { ok: true, url: url.origin };
}

/** 读取 `--gateway-url value` 或 `--gateway-url=value`。 */
export function gatewayUrlFromArgv(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--gateway-url') {
      return argv[index + 1] ?? '';
    }
    if (arg.startsWith('--gateway-url=')) {
      return arg.slice('--gateway-url='.length);
    }
  }
  return '';
}

/** 启动时按 CLI、环境变量、本地配置、默认地址解析 Gateway。 */
export function resolveGatewayUrl({
  argv,
  envUrl,
  storedUrl,
}: {
  argv: readonly string[];
  envUrl?: string;
  storedUrl?: string;
}): GatewayUrlResolution {
  const candidates: Array<[GatewayUrlResolution['source'], string]> = [
    ['cli', gatewayUrlFromArgv(argv)],
    ['env', envUrl ?? ''],
    ['stored', storedUrl ?? ''],
    ['default', DEFAULT_GATEWAY_URL],
  ];
  for (const [source, raw] of candidates) {
    const result = normalizeGatewayUrl(raw);
    if (result.ok) return { url: result.url, source };
  }
  return { url: DEFAULT_GATEWAY_URL, source: 'default' };
}

/** 只向密钥绑定的精确 Gateway origin 注入长期验证密钥。 */
export function gatewaySecretForUrl({
  gatewayUrl,
  storedUrl,
  tokenOrigin,
  token,
}: {
  gatewayUrl: string;
  storedUrl?: string;
  tokenOrigin?: string;
  token?: string;
}): string {
  const secret = token?.trim() ?? '';
  if (!secret) return '';
  const effective = normalizeGatewayUrl(gatewayUrl);
  if (!effective.ok) return '';
  const bound = normalizeGatewayUrl(tokenOrigin?.trim() || storedUrl?.trim() || '');
  return bound.ok && bound.url === effective.url ? secret : '';
}
