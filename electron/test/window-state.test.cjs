const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const Store = require('electron-store');
const path = require('node:path');
const { readWindowState, trackWindowState } = require('../window-state.cjs');

test('保存普通尺寸、最大化状态，关闭刷新防抖，丢失显示器时恢复可见位置', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nanobot-window-state-'));
  const store = new Store({ cwd: dir, projectVersion: '0.3.5' });
  const primary = { workArea: { x: 100, y: 40, width: 1280, height: 900 } };
  const secondary = { workArea: { x: -1600, y: 0, width: 1600, height: 1000 } };
  let displays = [primary, secondary];
  const screen = { getAllDisplays: () => displays, getPrimaryDisplay: () => primary };
  const normal = { x: -1400, y: 70, width: 1000, height: 700 };
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMinimized: () => false, isFullScreen: () => false,
    isMaximized: () => true, getNormalBounds: () => normal,
  });
  try {
    assert.deepEqual(readWindowState(store, screen), { x: 140, y: 80, width: 1200, height: 820, maximized: false });
    trackWindowState(win, store);
    win.emit('resize');
    win.emit('close');
    assert.deepEqual(store.get('window'), { ...normal, maximized: true });
    assert.deepEqual(readWindowState(store, screen), { ...normal, maximized: true });
    displays = [primary];
    assert.deepEqual(readWindowState(store, screen), { x: 100, y: 70, width: 1000, height: 700, maximized: true });
    win.isMinimized = () => true;
    normal.x = 200;
    win.emit('close');
    assert.equal(store.get('window').x, -1400);
    win.isMinimized = () => false;
    win.isMaximized = () => false;
    normal.width = 1080;
    win.emit('move'); win.emit('resize'); win.emit('close');
    assert.deepEqual(store.get('window'), { ...normal, maximized: false });
    store.set('window', { x: 100, y: 40, width: 4000, height: 3000 });
    assert.deepEqual(readWindowState(store, screen), { ...primary.workArea, maximized: false });
    store.set('window', { x: 'bad', y: 0, width: 1000, height: 700 });
    assert.equal(readWindowState(store, screen).width, 1200);
  } finally { win.emit('closed'); rmSync(dir, { recursive: true, force: true }); }
});
