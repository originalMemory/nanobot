const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopContext } = require('../desktop-context.cjs');

test('按需截图；前台、锁屏、休眠、未知状态拒绝，采集中状态变化丢弃图像', async () => {
  const app = new EventEmitter();
  const powerMonitor = new EventEmitter();
  let focused = false;
  let idle = 'active';
  let calls = 0;
  let onCapture = () => {};
  powerMonitor.getSystemIdleState = () => idle;
  const controller = createDesktopContext({ electron: {
    app, powerMonitor, BrowserWindow: { getFocusedWindow: () => focused ? {} : null },
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ id: 1, size: { width: 3840, height: 2160 } }) },
    desktopCapturer: { getSources: async (options) => {
      calls++;
      assert.equal(options.thumbnailSize.width, 1600);
      assert.equal(options.thumbnailSize.height, 900);
      onCapture();
      return [{ display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('fake-jpeg') } }];
    } },
  } });
  try {
    assert.equal(calls, 0);
    assert.equal((await controller.capture()).reason, 'captured');
    focused = true;
    assert.equal((await controller.capture()).reason, 'focused');
    focused = false;
    powerMonitor.emit('lock-screen');
    assert.equal((await controller.capture()).reason, 'locked');
    powerMonitor.emit('unlock-screen');
    powerMonitor.emit('suspend');
    assert.equal((await controller.capture()).reason, 'suspended');
    powerMonitor.emit('resume');
    idle = 'unknown';
    assert.equal((await controller.capture()).reason, 'unknown');
    idle = 'active';
    assert.equal(calls, 1);
    onCapture = () => { powerMonitor.emit('lock-screen'); powerMonitor.emit('unlock-screen'); };
    const changed = await controller.capture();
    assert.deepEqual(changed, { reason: 'state_changed' });
  } finally { controller.dispose(); }
  assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
});

test('同一时刻只采集一次，取消状态订阅后不再通知', async () => {
  const app = new EventEmitter();
  const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' });
  let finish;
  const controller = createDesktopContext({ electron: {
    app, powerMonitor, BrowserWindow: { getFocusedWindow: () => null },
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ id: 1, size: { width: 100, height: 100 } }) },
    desktopCapturer: { getSources: () => new Promise((resolve) => { finish = resolve; }) },
  } });
  let changed = 0;
  const unsubscribe = controller.subscribe(() => changed++);
  const pending = controller.capture();
  assert.equal((await controller.capture()).reason, 'busy');
  app.emit('browser-window-focus');
  unsubscribe();
  app.emit('browser-window-blur');
  assert.equal(changed, 1);
  finish([]);
  assert.equal((await pending).reason, 'state_changed');
  controller.dispose();
});
