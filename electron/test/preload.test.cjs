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
