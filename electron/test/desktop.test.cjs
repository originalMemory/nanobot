const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { completionKey, installDesktop } = require('../desktop.cjs');

function fixture() {
  const app = Object.assign(new EventEmitter(), { isPackaged: false, quit() { this.emit('before-quit'); } });
  const win = Object.assign(new EventEmitter(), {
    focused: true, visible: true, hidden: 0,
    isVisible() { return this.visible; }, isFocused() { return this.focused; },
    hide() { this.hidden++; this.visible = false; }, isDestroyed: () => false,
    webContents: { getURL: () => 'nanobot://desktop/', send: (...args) => sent.push(args) },
  });
  const sent = []; const notices = []; const shortcuts = new Map();
  let shown = 0;
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    show() { notices.push(this); }
  }
  const electron = {
    app, Tray, Notification, Menu: { buildFromTemplate: (value) => value },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; }, unregister: (key) => shortcuts.delete(key) },
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ id: 1, size: { width: 100, height: 80 } }) },
    desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('fixture') } }] },
    dialog: { showErrorBox: () => assert.fail('unexpected capture error') },
  };
  const controller = installDesktop({ getWindow: () => win, showWindow: () => { shown++; win.visible = true; }, electron });
  controller.bindWindow(win);
  return { app, win, sent, notices, shortcuts, controller, shown: () => shown };
}

test('只识别桌面完成事件，开始同步和其他会话不提醒', () => {
  assert.equal(completionKey({ event: 'turn_end', chat_id: 'desktop', turn_id: 't' }), 't');
  assert.equal(completionKey({ event: 'session_updated', chat_id: 'desktop', notification_id: 'n' }), 'n');
  assert.equal(completionKey({ event: 'session_updated', chat_id: 'desktop' }), null);
  assert.equal(completionKey({ event: 'turn_end', chat_id: 'other', turn_id: 't' }), null);
});

test('关闭隐藏到托盘，明确退出才能关闭；快捷键可再次隐藏', () => {
  const f = fixture(); let prevented = 0;
  f.win.emit('close', { preventDefault: () => prevented++ });
  assert.equal(prevented, 1); assert.equal(f.win.visible, false);
  f.shortcuts.get('CommandOrControl+Shift+E')();
  assert.equal(f.shown(), 1);
  f.shortcuts.get('CommandOrControl+Shift+E')();
  assert.equal(f.win.visible, false);
  f.app.emit('before-quit');
  f.win.emit('close', { preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  f.app.emit('will-quit'); assert.equal(f.shortcuts.size, 0);
});

test('通知去重，聚焦时不打扰；点击通知唤起窗口', () => {
  const f = fixture();
  f.controller.notify({ event: 'turn_end', chat_id: 'desktop', turn_id: 'foreground' });
  assert.equal(f.notices.length, 0);
  f.win.focused = false;
  const frame = { event: 'turn_end', chat_id: 'desktop', turn_id: 'background' };
  f.controller.notify(frame); f.controller.notify(frame);
  assert.equal(f.notices.length, 1);
  f.notices[0].emit('click'); assert.equal(f.shown(), 1);
});

test('截图只发附件事件，不发送聊天消息，并恢复窗口', async () => {
  const f = fixture();
  await f.controller.capture();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], 'desktop:screenshot');
  assert.match(f.sent[0][1], /^data:image\/jpeg;base64,/);
  assert.equal(f.win.hidden, 1); assert.equal(f.shown(), 1);
});
