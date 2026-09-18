const path = require('node:path');
const { readFile } = require('node:fs/promises');

const APP_ORIGIN = 'nanobot://desktop';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json',
};

function normalizeGateway(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入 gateway 的 HTTP(S) 地址，不含路径、账号或 token。');
  }
  return url.origin;
}

function isExternalLink(value) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function isMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'nanobot:' && url.host === 'desktop'
      && !url.username && !url.password
      && /^\/api\/media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname);
  } catch { return false; }
}

// 只代理 gateway 路由；静态界面始终来自当前桌面包。
function createHandler({ rendererDir, gateway, fetch: upstreamFetch }) {
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== 'nanobot:' || url.host !== 'desktop') {
      return new Response('Forbidden', { status: 403 });
    }
    if (/^\/(api|auth|webui)(\/|$)/.test(url.pathname)) {
      try {
        const headers = new Headers();
        for (const name of ['authorization', 'x-nanobot-auth', 'content-type', 'accept', 'range']) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        const target = `${gateway}${url.pathname}${url.search}`;
        const response = await upstreamFetch(target, {
          method: request.method, headers, redirect: 'error',
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
          signal: request.signal,
        });
        if (url.pathname === '/webui/bootstrap' && response.ok) {
          const body = await response.json();
          // 使用用户选择的 gateway，避免反向代理公布内网或 localhost 地址。
          const socket = new URL(gateway);
          socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
          socket.pathname = body.ws_path || '/';
          body.ws_url = socket.href;
          body.runtime_surface = 'native';
          body.runtime_capabilities = {};
          return Response.json(body);
        }
        const responseHeaders = new Headers(response.headers);
        // fetch 已解压正文，不能继续带上压缩长度与编码。
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        return new Response(response.body, {
          status: response.status, statusText: response.statusText, headers: responseHeaders,
        });
      } catch {
        return Response.json({ error: '无法连接 gateway，请从「连接」菜单检查地址或重试。' }, { status: 502 });
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    try {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(rendererDir, relative);
      if (!file.startsWith(`${path.resolve(rendererDir)}${path.sep}`)) {
        return new Response('Forbidden', { status: 403 });
      }
      const body = await readFile(file);
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}

module.exports = { APP_ORIGIN, normalizeGateway, isExternalLink, isMediaUrl, createHandler };
