// 真实 Electron + 本地模拟 gateway，不调用模型或已有个人服务。
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdir, mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

async function connectCDP(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let id = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw);
    if (frame.method === 'Runtime.exceptionThrown') console.error('页面异常:', JSON.stringify(frame.params));
    const entry = pending.get(frame.id);
    if (entry) {
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(JSON.stringify(frame.error)));
      else entry.resolve(frame.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  await send('Runtime.enable');
  return { socket, send, evaluate: async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  } };
}

async function main() {
  const storeOnly = process.argv.includes('--store');
  const libraryOnly = process.argv.includes("--library");
  const windowOnly = process.argv.includes('--window-state');
  const quitOnly = process.argv.includes('--quit');
  const desktopContextOnly = process.argv.includes('--desktop-context');
  const authOnly = process.argv.includes("--auth");
  const companionOnly = process.argv.includes("--companion");
  const surfacesOnly = process.argv.includes("--wallpaper-surfaces");
  const data = await mkdtemp(path.join(os.tmpdir(), 'nanobot-electron-smoke-'));
  const calls = [];
  const frames = [];
  const chatId = 'desktop';
  const history = [
    { id: 'shared-user', role: 'user', content: '这是另一渠道保存的历史', createdAt: 1700000000000 },
    { id: 'shared-answer', role: 'assistant', content: '统一历史已加载。', createdAt: 1700000001000 },
  ];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('content-type', 'application/json');
    const route = req.url.split('?')[0];
    if (route === '/api/media/smoke/webp') {
      res.setHeader('content-type', 'image/webp');
      res.end(Buffer.from('UklGRs4AAABXRUJQVlA4IMIAAACQEwCdASrgAaAAPm02mUmkIyKhICgAgA2JaW7hd2Ee3AAAHf5D32ych77ZOQ99snOIi5OQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ycKAA/vCn/9SMMXY//90ACn3xXwKomAAAAAAAAAAAAA==', 'base64'));
      return;
    }
    if (route === '/api/media/smoke/image' || route === '/wallpaper-fixture') {
      if (route === '/wallpaper-fixture') { assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); }
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR4nO3PsQ2AQBDEwO+/FNogpghimqABLiDyW7K0oYOd9VzH547z/txu/drtUAD6UAD6UAD60G+A5ejUB6D7AHQfgO79AMvRqQ9A9wHoPgDd+wGWo1MfgO4D0H0AuvcDLEenPgDdB6D7AHTvB1iOTn0Aug9A9wHo3g+wHJ36AHQfgO4D0L0fYDk69QHoPgDdB6B7PeAFhauCLAGKqwYAAAAASUVORK5CYII=', 'base64'));
      return;
    }
    if (authOnly && route === '/webui/bootstrap') { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (storeOnly && route === '/webui/bootstrap') assert.equal(req.headers['x-nanobot-auth'], 'preserved');
    let body = {};
    if (route === '/webui/bootstrap') body = { token: 'smoke', api_token: 'smoke', ws_path: '/socket', model_name: 'smoke-model' };
    else if (route === '/api/library') {
      assert.match(req.headers.authorization || '', /^Bearer /);
      const query = new URL(req.url, 'http://localhost').searchParams;
      const source = query.get('source'); const action = query.get('action'); const file = query.get('path');
      const root = source === 'notes' ? '/gateway/notes' : '/gateway/workspace';
      const tree = source === 'notes'
        ? { '': [{ name: '日记', kind: 'dir' }], '日记': [{ name: '2026', kind: 'dir' }], '日记/2026': [{ name: '09', kind: 'dir' }],
          '日记/2026/09': [{ name: '2026-09-18 周五.md', kind: 'file' }, { name: 'photo.webp', kind: 'file' }] }
        : { '': [{ name: 'README.md', kind: 'file' }, { name: 'memory', kind: 'dir' }], 'memory': [{ name: 'MEMORY.md', kind: 'file' }] };
      body = action === 'list'
        ? { root, path: file || '', kind: 'directory', entries: tree[file || ''] || [], truncated: false }
        : file?.endsWith('photo.webp')
          ? { root, path: file, kind: 'image', url: '/api/media/smoke/webp', truncated: false }
          : { root, path: action === 'today' ? '日记/2026/09/2026-09-18 周五.md' : file, kind: 'text',
            content: source === 'notes' ? '# Diary fixture\nA quiet day.\n\n> [!multi-column]\n>\n>> [!quote] 回忆\n>> 今天的风很温柔。\n>\n>> [!summary] 今日小结\n>> 做了一点喜欢的事。\n\n![[photo.webp|320]]' : '# Workspace document\nRead-only preview.',
            properties: { banner: '[[cover.webp]]', banner_y: 0.3, tags: ['日记', '生活'], mood: '平静' },
            image_sources: { 'cover.webp': '/api/media/smoke/webp', 'photo.webp': '/api/media/smoke/webp' }, images_omitted: 1,
            raw_content: '---\ntag: daily\n---\n# Diary fixture', frontmatter: 'tag: daily', language: 'markdown', size: 64, truncated: false };
    }
    else if (route === '/api/sessions') body = { sessions: [
      { key: 'websocket:old-test', title: 'OLD-TEST-RESIDUE', created_at: '', updated_at: '' },
    ] };
    else if (route.endsWith('/webui-thread')) body = {
      schemaVersion: 3, sessionKey: `websocket:${chatId}`, messages: history,
      has_pending_tool_calls: false, completed_turn_ids: [], active_turn_id: null,
      page: { before_cursor: null, has_more_before: false, loaded_message_count: history.length, user_message_offset: 0 },
    };
    else if (route === '/api/settings/api-service') body = { installed: false, running: false, managed: false, host: '127.0.0.1', port: 8900, timeout: 120, endpoint: 'http://127.0.0.1:8900/v1', command: 'nanobot serve' };
    else if (route === '/api/settings/usage') body = { days: [], total_tokens: 0, models: [], sources: {} };
    else if (route === '/api/voice/settings') body = { preset: null, voice: null, presets: [] };
    else if (route === '/api/settings') body = {
      agent: { model: 'smoke-model', provider: 'custom', model_preset: 'default', has_api_key: true, max_tokens: 4096, context_window_tokens: 200000 },
      providers: [{ name: 'custom', label: 'Mock', configured: true }],
      model_presets: [{ name: 'default', model: 'smoke-model', provider: 'custom', active: true, is_default: true }],
      model_call_order: ['default'], channels: {},
      web_search: { provider: 'duckduckgo', providers: [], max_results: 5, timeout: 30 },
      web: { enable: true, search: { max_results: 5, timeout: 30 }, fetch: { use_jina_reader: true } },
      image_generation: { enabled: false, provider: 'openrouter', providers: [], model: '',
        default_aspect_ratio: '1:1', default_image_size: '1K', max_images_per_turn: 4, save_dir: 'generated' },
      api: { host: '127.0.0.1', port: 8900, timeout: 120 },
      observability: { provider: 'langfuse', configured: false },
      runtime: { config_path: '/tmp/smoke/config.json', workspace_path: '/tmp/smoke',
        heartbeat: { enabled: true, interval_s: 1800 }, dream: { schedule: 'every 2h' }, unified_session: true },
      advanced: { restrict_to_workspace: false, webui_allow_local_service_access: false,
        webui_default_access_mode: 'default', mcp_server_count: 0, ssrf_whitelist_count: 0 },
      requires_restart: false,
    };
    else if (route === '/api/webui/sidebar-state') body = { pinned_keys: [], archived_keys: [], session_order: [], title_overrides: {}, tags_by_key: {}, collapsed_groups: {} };
    else if (route === '/api/commands') body = { commands: [] };
    else if (route === '/api/workspaces') body = {
      schema_version: 1, default_access_mode: 'default',
      default_scope: { project_path: '/tmp/smoke', access_mode: 'restricted' },
      controls: { can_change_project: false, can_use_full_access: false },
    };
    else if (route.includes('pairing')) body = { pending: [], approved: [] };
    else if (route.includes('skills')) body = { skills: [] };
    else if (route.includes('apps')) body = { apps: [] };
    else if (route.includes('mcp')) body = { presets: [] };
    res.end(JSON.stringify(body));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    const send = (value) => ws.send(JSON.stringify(value));
    send({ event: 'ready', chat_id: 'random-server-default', client_id: 'smoke-client' });
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw); frames.push(frame);
      if (frame.type === 'new_chat' || frame.type === 'attach') {
        send({ event: 'attached', chat_id: frame.chat_id || chatId });
      } else if (frame.type === 'webui_request') {
        send({ event: 'webui_response', request_id: frame.request_id, ok: true, result: {} });
      } else if (frame.type === 'message') {
        history.push(
          { id: `user-${history.length}`, role: 'user', content: frame.content, createdAt: Date.now() },
          { id: `assistant-${history.length}`, role: 'assistant', content: '桌面链路已接通。', createdAt: Date.now() },
        );
        const base = { chat_id: frame.chat_id, turn_id: frame.turn_id };
        send({ ...base, event: 'message_accepted', content: frame.content });
        send({ ...base, event: 'message', role: 'assistant', content: '桌面链路已接通。', text: '桌面链路已接通。' });
        send({ ...base, event: 'turn_end' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const savedBounds = { x: 100, y: 80, width: 1000, height: 720 };
  const companionScenes = path.join(data, 'scenes');
  if (companionOnly) {
    for (const scene of ['scene-a', 'scene-b']) {
      await mkdir(path.join(companionScenes, scene, 'idle'), { recursive: true });
      await mkdir(path.join(companionScenes, scene, 'working'), { recursive: true });
      await writeFile(path.join(companionScenes, scene, 'manifest.json'), JSON.stringify({ displayName: scene }));
    }
  }
  await writeFile(path.join(data, 'config.json'), JSON.stringify({
    ...(storeOnly ? { gateway: { url: gateway, token: 'preserved' },
      appearance: { theme: 'ink', language: 'en', wallpaper: { source: 'none', localOrder: 'random', intervalMinutes: 3 } },
      tts: { pauseSystemMedia: false }, avatarCompanion: { enabled: false, videoDirectory: '', timeSchedule: { day: '11:00' } } } : {}),
    ...(windowOnly ? { window: savedBounds } : {}),
    ...(companionOnly ? { avatarCompanion: { enabled: true, videoDirectory: companionScenes, videoScene: 'scene-a', detached: true,
      pinned: true, window: { x: 120, y: 80, width: 400, height: 320 } } } : {}),
    ...(authOnly || surfacesOnly ? { appearance: { wallpaper: { source: 'url', url: `${gateway}/wallpaper-fixture` }, opacity: 0.65 } } : {}),
  }));
  let stderr = '';
  const env = { ...process.env, NANOBOT_DESKTOP_DATA_DIR: data,
    NANOBOT_RAISE_SHORTCUT: '', NANOBOT_DESKTOP_NOTIFICATIONS: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NANOBOT_GATEWAY_URL;
  const electronBinary = process.env.NANOBOT_ELECTRON_BINARY || require('electron');
  if (desktopContextOnly && process.env.NANOBOT_ELECTRON_BINARY) throw new Error('桌面感知冒烟必须使用模拟采集入口，不能指定打包版');
  const args = process.env.NANOBOT_ELECTRON_BINARY ? [] : [desktopContextOnly
    ? path.join(__dirname, 'desktop-context-smoke-entry.cjs') : path.resolve(__dirname, '..')];
  // 只模拟采集设备，不使用自动授权开关，确保应用权限处理仍然受测。
  const child = spawn(electronBinary, [...args, '--remote-debugging-port=0', '--use-fake-device-for-media-stream'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const connections = [];
  let activePage;
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const address = await until(() => /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//.exec(stderr)?.[1], 'Electron 启动');
    const page = async (prefix, exact = false) => {
      const target = await until(async () => {
        const targets = await (await fetch(`http://${address}/json/list`)).json();
        return targets.find((item) => item.type === 'page' && (exact ? new URL(item.url).pathname === new URL(prefix).pathname : item.url.startsWith(prefix)));
      }, prefix);
      const cdp = await connectCDP(target.webSocketDebuggerUrl); connections.push(cdp.socket); return cdp;
    };
    if (storeOnly) {
      const chat = await page('nanobot://desktop/');
      await until(() => chat.evaluate('document.documentElement.dataset.theme === "ink"'), '原 store 主题');
      assert.equal((await chat.evaluate('window.nanobotHost.voice.settings()')).pauseSystemMedia, false);
      assert.equal((await chat.evaluate('window.nanobotHost.appearance.read()')).order, 'random');
      assert.equal((await chat.evaluate('window.nanobotHost.companion.read()')).schedule.day, '11:00');
      await chat.evaluate('window.nanobotHost.config.set("appearance.theme", "midnight")');
      const saved = JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8'));
      assert.equal(saved.gateway.url, gateway); assert.equal(saved.gateway.token, 'preserved');
      assert.equal(saved.appearance.theme, 'midnight');
      console.log('PASS: 原 store 自动连接，主题/语言/壁纸/语音/伴侣键可读，保存不覆盖其他配置');
      return;
    }
    const setup = await page('file:');
    await until(() => setup.evaluate('Boolean(window.desktopSetup)'), '连接页桥接');
    if (windowOnly) {
      assert.equal(await setup.evaluate('window.innerWidth'), savedBounds.width);
      assert.equal(await setup.evaluate('window.innerHeight'), savedBounds.height);
      await setup.evaluate('window.desktopSetup.windowControls.action("maximize")');
      await until(async () => {
        const saved = JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).window;
        return saved.maximized === true && saved.width === savedBounds.width && saved.height === savedBounds.height;
      }, '最大化时保留普通尺寸');
      await setup.evaluate('window.desktopSetup.windowControls.action("maximize")');
      await until(async () => JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).window.maximized === false, '还原状态落盘');
    }
    const rejected = await setup.evaluate('window.desktopSetup.connect("file:///tmp")');
    assert.equal(rejected.ok, false);
    assert.equal(await setup.evaluate('typeof require'), 'undefined');
    await setup.evaluate(`document.querySelector('#gateway').value=${JSON.stringify(gateway)};document.querySelector('form').requestSubmit()`);
    const chat = await page('nanobot://desktop/', companionOnly);
    activePage = chat;
    if (companionOnly) {
      const detached = await page('nanobot://desktop/companion.html');
      await until(() => detached.evaluate('Boolean(document.querySelector(".companion-window-header"))'), '独立伴侣窗口恢复');
      assert.equal(await detached.evaluate("Boolean(document.querySelector('[aria-label=\"Scene rotation\"]'))"), true);
      await until(() => detached.evaluate("Boolean(document.querySelector('[aria-label=\"Video scene\"]'))"), '伴侣视频组下拉菜单');
      assert.equal(await detached.evaluate('window.innerWidth'), 400);
      await until(() => detached.evaluate('Boolean(document.querySelector("video")?.videoWidth)'), '伴侣视频宽高');
      await until(() => detached.evaluate('Math.abs(window.innerWidth / (window.innerHeight - 32) - document.querySelector("video").videoWidth / document.querySelector("video").videoHeight) < 0.01'), '独立窗口视频比例');
      assert.equal((await detached.evaluate('window.companionWindow.read()')).pinned, true);
      await detached.evaluate(`document.querySelector('[aria-label="Stop keeping on top"]').click()`);
      await until(async () => JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).avatarCompanion.pinned === false, '置顶状态保存');
      await detached.evaluate(`document.querySelector('[aria-label="Return to chat"]').click()`);
      await until(async () => JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).avatarCompanion.detached === false, '切回聊天保存');
      console.log('PASS: 从连接页恢复独立伴侣窗口，独立尺寸、置顶和切回状态生效');
      return;
    }
    if (desktopContextOnly) {
      await until(() => frames.some(frame => frame.type === 'desktop_context_state' && frame.focused === false && frame.locked === false), '自动上报桌面状态');
      await sleep(250);
      const requestId = '1'.repeat(32);
      for (const client of wss.clients) client.send(JSON.stringify({ event: 'desktop_context_request', request_id: requestId }));
      const result = await until(() => frames.find(frame => frame.type === 'desktop_context_result' && frame.request_id === requestId), '按需截图响应');
      assert.equal(result.reason, 'captured');
      assert.match(result.image, /^data:image\/jpeg;base64,/);
      assert.ok(Buffer.from(result.image.split(',')[1], 'base64').length < 10000);
      assert.equal(frames.some(frame => frame.type === 'message'), false);
      console.log('PASS: Electron 自动上报状态，经既有 socket 按需返回模拟 JPEG，不触发聊天或读取真实屏幕');
      return;
    }
    if (quitOnly) {
      await until(() => chat.evaluate(`Boolean(document.querySelector('button[aria-label="Quit app"]'))`), '侧栏完全退出按钮');
      await chat.evaluate(`document.querySelector('button[aria-label="Quit app"]').click()`);
      await until(() => child.exitCode !== null, '完全退出 Electron');
      assert.equal(child.exitCode, 0);
      console.log('PASS: 侧栏完全退出按钮结束 Electron 进程，而不是隐藏到托盘');
      return;
    }
    if (windowOnly) {
      await until(() => chat.evaluate(`window.innerWidth === ${savedBounds.width} && window.innerHeight === ${savedBounds.height}`), '切换主窗口恢复尺寸');
      const saved = JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).window;
      for (const key of ['x', 'y', 'width', 'height']) assert.equal(saved[key], savedBounds[key]);
      console.log('PASS: 启动恢复尺寸、最大化保留普通尺寸、还原状态落盘、切换主窗口保持位置和大小');
      return;
    }
    if (authOnly) {
      await until(() => chat.evaluate('Boolean(document.querySelector("#webui-auth-title"))'), '认证页');
      await until(() => chat.evaluate('document.querySelector("[data-testid=desktop-titlebar]")?.offsetHeight === 30'), '认证页窗口顶栏');
      if (process.platform !== 'darwin') {
        assert.equal(await chat.evaluate(`(() => {
          const button = document.querySelector('[aria-label="Close"]');
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })()`), true, '认证页不能覆盖关闭按钮');
      }
      await sleep(200);
      assert.equal(await chat.evaluate('Boolean(document.querySelector(".desktop-wallpaper"))'), false);
      assert.equal(calls.includes('/wallpaper-fixture'), false);
      const shot = await chat.send('Page.captureScreenshot');
      const file = path.join(os.tmpdir(), 'nanobot-f05-review-auth-fixed.png');
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      console.log(`PASS: 认证页不渲染或加载已配置壁纸；截图 ${file}`);
      return;
    }
    if (libraryOnly) {
        await until(() => chat.evaluate('document.querySelector("[data-testid=desktop-titlebar]")?.offsetHeight === 30'), '无边框窗口顶栏');
        if (process.platform !== 'darwin') {
          await chat.evaluate(`document.querySelector('[aria-label="Maximize"]').click()`);
          await until(() => chat.evaluate(`Boolean(document.querySelector('[aria-label="Restore"]'))`), '窗口最大化');
          await chat.evaluate(`document.querySelector('[aria-label="Restore"]').click()`);
          await until(() => chat.evaluate(`Boolean(document.querySelector('[aria-label="Maximize"]'))`), '窗口还原');
        }
      await until(() => chat.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Workspace')`), '工作区入口');
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Workspace').click()`);
      await until(() => chat.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'README.md')`), 'gateway 目录列表');
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'README.md').click()`);
        await until(() => chat.evaluate('document.querySelector("article")?.innerText.includes("Workspace document")'), 'Markdown 预览');
        assert.equal(await chat.evaluate('Boolean(document.querySelector(".host-drag-region"))'), false);
      assert.equal(await chat.evaluate('Boolean(document.querySelector("select[aria-label=Library]"))'), false);
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'memory').click()`);
      await until(() => chat.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'MEMORY.md')`), '展开目录');
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'memory').click()`);
      assert.equal(await chat.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'MEMORY.md')`), false);
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Notes library').click()`);
      await until(() => chat.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Today’s diary')`), '今日日记入口');
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Today’s diary').click()`);
        await until(() => chat.evaluate('document.querySelector("article")?.innerText.includes("Diary fixture")'), '今日日记预览');
        assert.equal(await chat.evaluate('Boolean(document.querySelector(".host-drag-region"))'), false);
      assert.equal(await chat.evaluate(`['日记', '2026', '09'].every(name => Array.from(document.querySelectorAll('button')).find(button => button.textContent === name)?.getAttribute('aria-expanded') === 'true')`), true);
        await until(() => chat.evaluate('document.querySelector("article img")?.naturalWidth > 0'), '括号文件名图片映射');
        await until(() => chat.evaluate(`document.querySelector('.diary-document img[alt="photo.webp"]')?.naturalWidth === 480`), 'WebP 正文图片');
        assert.equal(await chat.evaluate('document.querySelectorAll("[data-callout=multi-column] > .obsidian-callout").length'), 2);
        assert.equal(await chat.evaluate('getComputedStyle(document.querySelector("[data-callout=multi-column]")).display'), 'flex');
        assert.equal(await chat.evaluate('document.querySelector(".diary-document dl")?.textContent.includes("生活")'), true);
      assert.ok(await chat.evaluate('document.querySelector("article [role=status]")?.textContent.includes("1 local image")'));
      const shot = await chat.send('Page.captureScreenshot');
      const file = path.join(os.tmpdir(), 'nanobot-library-smoke.png');
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Source').click()`);
      await until(() => chat.evaluate('document.querySelector("article")?.innerText.includes("# Diary fixture")'), '原文查看');
        await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'photo.webp').click()`);
      await until(() => chat.evaluate('document.querySelector("article img")?.naturalWidth > 0'), '图片预览');
      await chat.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Back to inbox').click()`);
      await until(() => chat.evaluate('Boolean(document.querySelector("textarea")?.offsetParent)'), '返回收件箱');
      console.log(`PASS: F06 桌面入口、鉴权读取、Markdown/原文/图片及今日日记；截图 ${file}`);
      return;
    }
    if (surfacesOnly) {
      await until(() => chat.evaluate('document.documentElement.dataset.wallpaper === "on" && Boolean(document.querySelector(".desktop-user-bubble")) && Boolean(document.querySelector(".thread-composer-surface"))'), '壁纸与聊天表层');
      for (const theme of ['light', 'dark']) {
        await chat.evaluate(`document.documentElement.dataset.theme = '${theme}'; document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
        for (const focused of [false, true]) {
          await chat.evaluate(focused ? 'document.querySelector("textarea").focus()' : 'document.activeElement.blur()');
          await sleep(250);
          const surfaces = await chat.evaluate(`Array.from(document.querySelectorAll('.desktop-user-bubble, .thread-composer-surface, .composer-model-pill, .thread-header-controls, .desktop-titlebar')).map(element => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, opacity: style.opacity };
          })`);
          for (const surface of surfaces) {
            assert.match(surface.background, /rgba\(.*[,]\s*0\.65\)/);
            assert.equal(surface.opacity, '1');
          }
          assert.equal(await chat.evaluate('getComputedStyle(document.querySelector(".thread-composer-dock")).backgroundColor'), 'rgba(0, 0, 0, 0)');
          assert.equal(await chat.evaluate(`(() => {
            const titlebar = document.querySelector('.desktop-titlebar');
            const style = getComputedStyle(titlebar);
            return style.position === 'relative' && Number(style.zIndex) > 0;
          })()`), true, '标题栏绘制在固定壁纸层上方');
          if (process.platform !== 'darwin') {
            assert.equal(await chat.evaluate(`Array.from(document.querySelectorAll('.desktop-titlebar button')).filter(button => {
              const rect = button.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && button.querySelector('svg')
                && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            }).length`), 3, '三个窗口按钮均可见并可点击');
          }
        }
      }
      const shot = await chat.send('Page.captureScreenshot');
      const file = path.join(os.tmpdir(), 'nanobot-wallpaper-surfaces.png');
      assert.equal(await chat.evaluate(`Array.from(document.querySelectorAll('[data-testid="thread-header"] > div:last-child button')).every(button => button.title && button.title === button.getAttribute('aria-label'))`), true, '右侧按钮都有原生悬停提示');
      const widths = await chat.evaluate(`['[data-testid="thread-message-region"] > div', '.thread-composer-surface'].map(selector => getComputedStyle(document.querySelector(selector)).maxWidth)`);
      assert.deepEqual(widths, ['928px', '928px'], '消息列和输入框上限与 lover 一致');
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      await chat.evaluate('delete document.documentElement.dataset.wallpaper');
      await sleep(250);
      assert.match(await chat.evaluate('getComputedStyle(document.querySelector(".desktop-user-bubble")).backgroundColor'), /^rgb\(/);
      assert.match(await chat.evaluate('getComputedStyle(document.querySelector(".thread-composer-dock")).backgroundColor'), /^rgb\(/);
      console.log(`PASS: 明暗主题与聚焦状态下背景半透明、内容保持不透明，关闭壁纸恢复背景；截图 ${file}`);
      return;
    }
    await until(() => calls.includes('/webui/bootstrap'), 'bootstrap');
    await until(() => chat.evaluate('Boolean(document.querySelector("textarea"))'), '上游聊天输入框');
    await until(() => chat.evaluate('document.body.innerText.includes("统一历史已加载")'), '加载统一历史');
    await until(() => chat.evaluate('Boolean(document.querySelector("nav")?.innerText.match(/Chat|聊天/))'), '聊天入口');
    assert.equal(await chat.evaluate('document.body.innerText.includes("OLD-TEST-RESIDUE")'), false);
    assert.equal(await chat.evaluate('typeof require'), 'undefined');
    assert.equal(await chat.evaluate('typeof window.desktopSetup'), 'undefined');
    assert.equal(await chat.evaluate(`window.nanobotHost.openSocket('ws://example.com/').then(() => false, () => true)`), true);
    assert.equal(await chat.evaluate(`navigator.mediaDevices.getUserMedia({audio:true})
      .then(stream => { stream.getTracks().forEach(track => track.stop()); return 'audio-ok'; }, error => error.name)`), 'audio-ok');
    assert.equal(await chat.evaluate(`navigator.mediaDevices.getUserMedia({video:true})
      .then(stream => { stream.getTracks().forEach(track => track.stop()); return 'unexpected-video'; }, error => error.name)`), 'NotAllowedError');
    await chat.evaluate(`window.open('/api/media/smoke/image', '_blank'); void 0`);
    const preview = await page('file:');
    await until(() => preview.evaluate('Boolean(document.querySelector("img")?.naturalWidth)'), '图片附件预览');
    assert.equal(await preview.evaluate('typeof window.nanobotHost'), 'undefined');
    assert.equal(await preview.evaluate('typeof window.desktopSetup'), 'undefined');
    assert.equal(await preview.evaluate('typeof require'), 'undefined');
    assert.equal(await preview.evaluate(`navigator.mediaDevices.getUserMedia({audio:true})
      .then(stream => { stream.getTracks().forEach(track => track.stop()); return 'unexpected-audio'; }, error => error.name)`), 'NotAllowedError');
    await preview.send('Page.close');
    await until(() => chat.evaluate(`(() => {
      const input = document.querySelector('textarea');
      if (!input || input.disabled) return false;
      input.focus(); return true;
    })()`), '输入框可编辑');
    await chat.send('Input.insertText', { text: '你好，测试桌面连接' });
    await until(() => chat.evaluate(`(() => {
      const button = document.querySelector('button[type="submit"]');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`), '发送按钮');
    await until(() => frames.some((frame) => frame.type === 'message'), '发送消息');
    assert.ok(frames.filter((frame) => frame.type === 'message').every((frame) => frame.chat_id === 'desktop'));
    assert.equal(frames.some((frame) => frame.type === 'new_chat'), false);
    await until(() => chat.evaluate('document.body.innerText.includes("桌面链路已接通")'), '回复展示');
    assert.equal(await chat.evaluate(`Array.from(document.querySelectorAll('button')).some(button => /Add pane|Fork|添加面板|分叉/i.test(button.getAttribute('aria-label') || ''))`), false);
    history.push(
      { id: 'external-user', role: 'user', content: '飞书发来的新消息', createdAt: Date.now(), source: { kind: 'channel', label: 'feishu' } },
      { id: 'external-answer', role: 'assistant', content: '外部渠道回复已自动同步。', createdAt: Date.now(), source: { kind: 'channel', label: 'feishu' } },
    );
    for (const client of wss.clients) client.send(JSON.stringify({ event: 'session_updated', chat_id: chatId, scope: 'thread' }));
    await until(() => chat.evaluate('document.body.innerText.includes("外部渠道回复已自动同步")'), '外部消息自动同步（不刷新窗口）');
    assert.equal(await chat.evaluate('document.querySelectorAll("[data-message-source=channel]").length'), 1);
    for (const client of wss.clients) client.send(JSON.stringify({ event: 'session_updated', chat_id: chatId, scope: 'thread' }));
    await sleep(500);
    assert.equal(await chat.evaluate('document.body.innerText.split("外部渠道回复已自动同步。").length - 1'), 1);
    assert.equal(JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).gateway.url, gateway);
    await chat.evaluate("location.hash = '#/settings?section=appearance&chat=websocket%3Adesktop'");
    await until(() => chat.evaluate('document.querySelectorAll("[data-theme-choice]").length === 9'), '桌面九套主题');
    for (const theme of ['light', 'dark', 'midnight', 'desert', 'neon', 'marshmallow', 'ink', 'party', 'rainbow']) {
      await chat.evaluate(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
      await until(() => chat.evaluate(`document.documentElement.dataset.theme === '${theme}'`), `主题 ${theme}`);
      await sleep(350); // Wait for theme/route transitions before visual inspection.
      assert.equal(await chat.evaluate('Array.from(document.querySelectorAll("[data-theme-choice]")).every(button => button.scrollWidth <= button.clientWidth)'), true, '主题名称不溢出');
      const settingsShot = await chat.send('Page.captureScreenshot');
      await writeFile(path.join(os.tmpdir(), `nanobot-theme-${theme}-settings.png`), Buffer.from(settingsShot.data, 'base64'));
      await chat.evaluate("location.hash = '#/chat/websocket%3Adesktop'");
      await until(() => chat.evaluate('Boolean(document.querySelector("textarea")?.offsetParent)'), '回到聊天');
      assert.equal(await chat.evaluate(`(() => {
        const bubble = document.querySelector('.desktop-user-bubble');
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'hsl(var(--primary))';
        probe.style.color = 'hsl(var(--primary-foreground))';
        document.body.append(probe);
        const actual = getComputedStyle(bubble), expected = getComputedStyle(probe);
        const matches = actual.backgroundColor === expected.backgroundColor && actual.color === expected.color;
        probe.remove(); return matches;
      })()`), true, `${theme} 用户气泡使用成对主色`);
      const shot = await chat.send('Page.captureScreenshot');
      await writeFile(path.join(os.tmpdir(), `nanobot-theme-${theme}-chat.png`), Buffer.from(shot.data, 'base64'));
      await chat.evaluate("location.hash = '#/settings?section=appearance&chat=websocket%3Adesktop'");
      await until(() => chat.evaluate('Boolean(document.querySelector("[data-theme-choice=midnight]")?.offsetParent)'), '主题设置');
    }
    await chat.evaluate('document.querySelector("[data-theme-choice=midnight]").click()');
    await until(() => chat.evaluate('document.documentElement.dataset.theme === "midnight" && document.documentElement.classList.contains("dark")'), '深夜主题暗色模式');
    assert.equal(await chat.evaluate('localStorage.getItem("nanobot-webui.theme")'), 'midnight');
    await chat.evaluate("location.hash = '#/chat/websocket%3Adesktop'");
    await until(() => chat.evaluate('Boolean(document.querySelector("textarea")?.offsetParent)'), '回到聊天');
    const screenshot = await chat.send('Page.captureScreenshot');
    const screenshotPath = path.join(os.tmpdir(), 'nanobot-electron-smoke.png');
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    const bootstrapCount = calls.filter((route) => route === '/webui/bootstrap').length;
    const attachCount = frames.filter((frame) => frame.type === 'attach' && frame.chat_id === 'desktop').length;
    await chat.send('Page.reload');
    await until(() => calls.filter((route) => route === '/webui/bootstrap').length > bootstrapCount, '重新连接');
    await until(() => wss.clients.size === 1, '重载后旧 WebSocket 清理');
    await until(() => frames.filter((frame) => frame.type === 'attach' && frame.chat_id === 'desktop').length > attachCount, '重载后订阅同一桌面入口');
    assert.equal(frames.some((frame) => frame.type === 'new_chat'), false);
    await until(() => chat.evaluate('document.body.innerText.includes("统一历史已加载") && document.body.innerText.includes("桌面链路已接通")'), '刷新后保留完整历史');
    assert.equal(await chat.evaluate('document.body.innerText.split("桌面链路已接通。").length - 1'), 1);
    // 检查共享设置页的表面色，而不只检查聊天背景。
    for (const theme of ['desert', 'neon']) {
      await chat.evaluate("location.hash = '#/settings?section=appearance&chat=websocket%3Adesktop'");
      await until(() => chat.evaluate('Boolean(document.querySelector("[data-theme-choice]")?.offsetParent)'), '外观页');
      await chat.evaluate(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
      for (const section of ['overview', 'models', 'runtime']) {
        await chat.evaluate(`location.hash = '#/settings?section=${section}&chat=websocket%3Adesktop'`);
        await sleep(350);
        assert.ok(await chat.evaluate('document.body.innerText.length > 100'), `${theme} ${section} 页面可渲染`);
        const shot = await chat.send('Page.captureScreenshot');
        await writeFile(path.join(os.tmpdir(), `nanobot-theme-${theme}-${section}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
    await chat.evaluate("localStorage.setItem('nanobot.locale', 'zh-CN'); location.hash = '#/settings?section=appearance&chat=websocket%3Adesktop'");
    await chat.send('Page.reload');
    await until(() => chat.evaluate('document.querySelector("[data-theme-choice=midnight]")?.textContent === "深海蓝"'), '中文主题名称');
    await chat.evaluate('document.querySelector("[data-theme-choice=midnight]").click()');
    assert.equal(await chat.evaluate('document.documentElement.dataset.theme'), 'midnight');
    assert.equal(await chat.evaluate('document.documentElement.classList.contains("dark")'), true);
    await until(() => chat.evaluate('Boolean(document.querySelector("[data-testid=desktop-appearance-settings]"))'), '桌面外观偏好');
    await chat.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="显示名称"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Homura smoke');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(() => chat.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('[data-testid=desktop-appearance-settings] button')).find(item => item.textContent === '保存');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`), '保存显示名称');
    await until(() => chat.evaluate('window.nanobotHost.appearance.read().then(value => value.name === "Homura smoke")'), '本机身份保存');
    await chat.evaluate(`window.nanobotHost.appearance.read().then(value => window.nanobotHost.appearance.save({ ...value, source: 'url', url: '${gateway}/wallpaper-fixture', opacity: 0.65 }))`);
    await chat.send('Page.reload');
    await until(() => chat.evaluate('Boolean(document.querySelector("[data-testid=desktop-wallpaper]"))'), '壁纸恢复');
    assert.equal(await chat.evaluate('document.documentElement.style.getPropertyValue("--desktop-panel-opacity")'), '0.65');
    await chat.evaluate('document.querySelector("[data-testid=desktop-appearance-settings]").scrollIntoView({ block: "start" })');
    await sleep(350);
    const appearanceShot = await chat.send('Page.captureScreenshot');
    await writeFile(path.join(os.tmpdir(), 'nanobot-appearance-settings-smoke.png'), Buffer.from(appearanceShot.data, 'base64'));

    await chat.evaluate("location.hash = '#/chat/websocket%3Adesktop'");
    await until(() => chat.evaluate('Array.from(document.querySelectorAll("[data-testid=desktop-identity]")).some(item => item.textContent.includes("Homura smoke"))'), '聊天显示头像名称');
    assert.equal(await chat.evaluate('getComputedStyle(document.querySelector(".thread-workspace")).backgroundColor'), 'rgba(0, 0, 0, 0)');
    const wallpaperShot = await chat.send('Page.captureScreenshot');
    await writeFile(path.join(os.tmpdir(), 'nanobot-wallpaper-smoke.png'), Buffer.from(wallpaperShot.data, 'base64'));
    await chat.evaluate('window.nanobotHost.appearance.read().then(value => window.nanobotHost.appearance.save({ ...value, source: "none" }))');
    await chat.send('Page.reload');
    await until(() => chat.evaluate('Boolean(document.querySelector("[data-testid=desktop-identity]"))'), '身份重载');
    assert.equal(await chat.evaluate('document.documentElement.dataset.wallpaper'), undefined);
    console.log('PASS: 连接页、认证隔离边界、图片预览、音频授权/视频拒绝、WebUI 与 WebSocket 消息收发');
    console.log(`截图: ${screenshotPath}`);
  } catch (error) {
    if (activePage) console.error('页面:', await activePage.evaluate('document.body.innerText'));
    console.error('请求:', calls); console.error('消息:', frames); console.error(stderr.slice(-5000)); throw error;
  } finally {
    clearTimeout(timer);
    connections.forEach((socket) => socket.close());
    const stopped = child.exitCode !== null || child.signalCode !== null;
    if (!stopped) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
    wss.clients.forEach((client) => client.terminate());
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
