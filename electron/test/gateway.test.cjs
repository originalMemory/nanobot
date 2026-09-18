const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { normalizeGateway, createHandler, isExternalLink, isMediaUrl } = require('../gateway.cjs');
const { spawnSync } = require('node:child_process');

test('正式打包命令可被 shell 正确解析', { skip: process.platform === 'win32' }, () => {
  const script = require('../package.json').scripts.package;
  const result = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('附件预览只接受当前应用的签名媒体路径', () => {
  assert.equal(isMediaUrl('nanobot://desktop/api/media/signature/payload'), true);
  for (const value of ['nanobot://desktop/api/settings', 'nanobot://desktop/index.html',
    'nanobot://other/api/media/a/b', 'file:///tmp/image.png', 'https://example.com/a.png',
    'nanobot://user@desktop/api/media/a/b']) assert.equal(isMediaUrl(value), false);
});

test('后端地址只接受不含凭据的 HTTP(S) origin', () => {
  assert.equal(normalizeGateway(' http://nas:8765/ '), 'http://nas:8765');
  for (const value of ['file:///tmp', 'javascript:alert(1)', 'https://user:pass@nas',
    'https://nas/?token=secret', 'https://nas/#secret', 'https://nas/path']) {
    assert.throws(() => normalizeGateway(value));
  }
  assert.equal(isExternalLink('https://example.com'), true);
  assert.equal(isExternalLink('file:///etc/passwd'), false);
});

test('本地静态资源与鉴权 API 共用 origin，bootstrap socket 指向所选 gateway', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nanobot-desktop-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>local WebUI</h1>');
  const calls = [];
  const handler = createHandler({ rendererDir: dir, gateway: 'https://nas.example:8765',
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/webui/bootstrap')) {
        return Response.json({ token: 'test-token', ws_path: '/socket', ws_url: 'ws://localhost:1/' });
      }
      return Response.json({ ok: true });
    },
  });
  assert.equal(await (await handler(new Request('nanobot://desktop/'))).text(), '<h1>local WebUI</h1>');
  assert.equal(calls.length, 0);
  const bootstrap = await (await handler(new Request('nanobot://desktop/webui/bootstrap', {
    headers: { 'X-Nanobot-Auth': 'secret' },
  }))).json();
  assert.equal(bootstrap.ws_url, 'wss://nas.example:8765/socket');
  assert.equal(bootstrap.token, 'test-token');
  assert.equal(calls[0].options.headers.get('X-Nanobot-Auth'), 'secret');
  assert.equal(calls[0].options.redirect, 'error');
  await handler(new Request('nanobot://desktop/api/upload?q=1', {
    method: 'POST', headers: { Authorization: 'Bearer short-lived', 'Content-Type': 'text/plain' }, body: 'payload',
  }));
  assert.equal(calls[1].url, 'https://nas.example:8765/api/upload?q=1');
  assert.equal(Buffer.from(calls[1].options.body).toString(), 'payload');
  assert.equal(calls[1].options.headers.get('Authorization'), 'Bearer short-lived');
  assert.equal((await handler(new Request('nanobot://elsewhere/api/settings'))).status, 403);
  assert.equal((await handler(new Request('nanobot://desktop/..%2fsecret'))).status, 403);
  assert.equal((await handler(new Request('nanobot://desktop/missing.js'))).status, 404);
});

test('gateway 不可达时返回可恢复错误；HTTP 鉴权错误不被吞掉', async () => {
  let failing = true;
  const handler = createHandler({ rendererDir: '/unused', gateway: 'http://localhost:8765',
    fetch: async () => {
      if (failing) throw new Error('ECONNREFUSED');
      return new Response('unauthorized', { status: 401 });
    },
  });
  assert.equal((await handler(new Request('nanobot://desktop/api/settings'))).status, 502);
  failing = false;
  assert.equal((await handler(new Request('nanobot://desktop/webui/bootstrap'))).status, 401);
});
