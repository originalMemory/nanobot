const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWindowState, trackWindowState } = require('../window-state.cjs');

test('保存普通尺寸、最大化状态，关闭刷新防抖，丢失显示器时恢复可见位置', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nanobot-window-state-'));
  const file = path.join(dir, 'window.json');
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
    assert.deepEqual(readWindowState(file, screen), { x: 140, y: 80, width: 1200, height: 820, maximized: false });
    trackWindowState(win, file);
    win.emit('resize');
    win.emit('close');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...normal, maximized: true });
    assert.deepEqual(readWindowState(file, screen), { ...normal, maximized: true });
    displays = [primary];
    assert.deepEqual(readWindowState(file, screen), { x: 100, y: 70, width: 1000, height: 700, maximized: true });
    win.isMinimized = () => true;
    normal.x = 200;
    win.emit('close');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, -1400);
    win.isMinimized = () => false;
    win.isMaximized = () => false;
    normal.width = 1080;
    win.emit('move'); win.emit('resize'); win.emit('close');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...normal, maximized: false });
    writeFileSync(file, JSON.stringify({ x: 100, y: 40, width: 4000, height: 3000 }));
    assert.deepEqual(readWindowState(file, screen), { ...primary.workArea, maximized: false });
    writeFileSync(file, JSON.stringify({ x: 'bad', y: 0, width: 1000, height: 700 }));
    assert.equal(readWindowState(file, screen).width, 1200);
  } finally { win.emit('closed'); rmSync(dir, { recursive: true, force: true }); }
});
