// 真实 Electron + 本地模拟 gateway，不调用模型或已有个人服务。
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
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
    if (route === '/api/media/smoke/image') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64'));
      return;
    }
    let body = {};
    if (route === '/webui/bootstrap') body = { token: 'smoke', api_token: 'smoke', ws_path: '/socket', model_name: 'smoke-model' };
    else if (route === '/api/sessions') body = { sessions: [
      { key: 'websocket:old-test', title: 'OLD-TEST-RESIDUE', created_at: '', updated_at: '' },
    ] };
    else if (route.endsWith('/webui-thread')) body = {
      schemaVersion: 3, sessionKey: `websocket:${chatId}`, messages: history,
      has_pending_tool_calls: false, completed_turn_ids: [], active_turn_id: null,
      page: { before_cursor: null, has_more_before: false, loaded_message_count: history.length, user_message_offset: 0 },
    };
    else if (route === '/api/settings') body = {
      agent: { model: 'smoke-model', provider: 'custom', model_preset: 'default', has_api_key: true, max_tokens: 4096, context_window_tokens: 200000 },
      providers: [{ name: 'custom', label: 'Mock', configured: true }],
      model_presets: [{ name: 'default', model: 'smoke-model', provider: 'custom', active: true, is_default: true }],
      model_call_order: ['default'], channels: {},
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
  let stderr = '';
  const env = { ...process.env, NANOBOT_DESKTOP_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NANOBOT_GATEWAY_URL;
  const electronBinary = process.env.NANOBOT_ELECTRON_BINARY || require('electron');
  const args = process.env.NANOBOT_ELECTRON_BINARY ? [] : [path.resolve(__dirname, '..')];
  // 只模拟采集设备，不使用自动授权开关，确保应用权限处理仍然受测。
  const child = spawn(electronBinary, [...args, '--remote-debugging-port=0', '--use-fake-device-for-media-stream'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const connections = [];
  let activePage;
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const address = await until(() => /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//.exec(stderr)?.[1], 'Electron 启动');
    const page = async (prefix) => {
      const target = await until(async () => {
        const targets = await (await fetch(`http://${address}/json/list`)).json();
        return targets.find((item) => item.type === 'page' && item.url.startsWith(prefix));
      }, prefix);
      const cdp = await connectCDP(target.webSocketDebuggerUrl); connections.push(cdp.socket); return cdp;
    };
    const setup = await page('file:');
    await until(() => setup.evaluate('Boolean(window.desktopSetup)'), '连接页桥接');
    const rejected = await setup.evaluate('window.desktopSetup.connect("file:///tmp")');
    assert.equal(rejected.ok, false);
    assert.equal(await setup.evaluate('typeof require'), 'undefined');
    await setup.evaluate(`document.querySelector('#gateway').value=${JSON.stringify(gateway)};document.querySelector('form').requestSubmit()`);
    const chat = await page('nanobot://desktop/');
    activePage = chat;
    await until(() => calls.includes('/webui/bootstrap'), 'bootstrap');
    await until(() => chat.evaluate('Boolean(document.querySelector("textarea"))'), '上游聊天输入框');
    await until(() => chat.evaluate('document.body.innerText.includes("统一历史已加载")'), '加载统一历史');
    await until(() => chat.evaluate('Boolean(document.querySelector("nav")?.innerText.match(/Unified inbox|统一收件箱/))'), '统一收件箱入口');
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
    assert.equal(await chat.evaluate('document.querySelectorAll("[data-channel-source]").length'), 2);
    for (const client of wss.clients) client.send(JSON.stringify({ event: 'session_updated', chat_id: chatId, scope: 'thread' }));
    await sleep(500);
    assert.equal(await chat.evaluate('document.body.innerText.split("外部渠道回复已自动同步。").length - 1'), 1);
    assert.equal(JSON.parse(await readFile(path.join(data, 'connection.json'), 'utf8')).gateway, gateway);
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
    console.log('PASS: 连接页、认证隔离边界、图片预览、音频授权/视频拒绝、WebUI 与 WebSocket 消息收发');
    console.log(`截图: ${screenshotPath}`);
  } catch (error) {
    if (activePage) console.error('页面:', await activePage.evaluate('document.body.innerText'));
    console.error('请求:', calls); console.error('消息:', frames); console.error(stderr.slice(-5000)); throw error;
  } finally {
    clearTimeout(timer);
    connections.forEach((socket) => socket.close());
    const stopped = child.exitCode !== null || child.signalCode !== null;
    if (!stopped) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    wss.clients.forEach((client) => client.terminate());
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
