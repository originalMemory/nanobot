const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { EventEmitter } = require('node:events');

// 模拟宿主 IPC，不读取真实屏幕。
test('截图从其他页面返回收件箱，等待 composer 挂载后只投递一次', () => {
  const ipcRenderer = new EventEmitter();
  const location = { protocol: 'nanobot:', host: 'desktop', hash: '#/settings' };
  let host;
  runInNewContext(readFileSync(require.resolve('../preload.cjs'), 'utf8'), {
    location,
    process: { platform: 'win32' },
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { host = api; } } }),
  });
  const data = 'data:image/jpeg;base64,ZmFrZQ==';
  ipcRenderer.emit('desktop:screenshot', {}, data);
  assert.equal(location.hash, '#/chat/websocket%3Adesktop');
  const received = [];
  const unsubscribe = host.onScreenshot((value) => received.push(value));
  assert.deepEqual(received, [data]);
  unsubscribe();
  const next = [];
  host.onScreenshot((value) => next.push(value));
  assert.deepEqual(next, []);
  ipcRenderer.emit('desktop:screenshot', {}, data);
  assert.deepEqual(next, [data]);
});

test('窗口桥接只暴露固定 IPC，并可解除状态监听', async () => {
  const ipcRenderer = new EventEmitter();
  const calls = [];
  ipcRenderer.invoke = async (...args) => { calls.push(args); return false; };
  for (const location of [{ protocol: 'nanobot:', host: 'desktop' }, { protocol: 'file:' }]) {
    let api;
    runInNewContext(readFileSync(require.resolve('../preload.cjs'), 'utf8'), {
      location, process: { platform: 'win32' },
      require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } }),
    });
    assert.equal(api.windowControls.isMac, false);
    await api.windowControls.read();
    await api.windowControls.action('maximize');
    const states = [];
    const off = api.windowControls.onState((state) => states.push(state));
    ipcRenderer.emit('desktop:window-state', {}, true);
    off();
    ipcRenderer.emit('desktop:window-state', {}, false);
    assert.deepEqual(states, [true]);
  }
  assert.deepEqual(calls, [
    ['desktop:window-state'], ['desktop:window-action', 'maximize'],
    ['desktop:window-state'], ['desktop:window-action', 'maximize'],
  ]);
});
