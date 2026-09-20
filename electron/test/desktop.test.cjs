const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { completionKey, installDesktop } = require('../desktop.cjs');

function fixture() {
  const app = Object.assign(new EventEmitter(), {
    hidden: 0, isPackaged: false, getLocale: () => 'zh-CN',
    hide() { this.hidden++; }, quit() { this.emit('before-quit'); },
  });
  const win = Object.assign(new EventEmitter(), {
    focused: true, visible: true, hidden: 0,
    isVisible() { return this.visible; }, isFocused() { return this.focused; },
    hide() { this.hidden++; this.visible = false; }, isDestroyed: () => false,
    setProgressBar: (...args) => progress.push(args),
    webContents: { getURL: () => 'nanobot://desktop/', send: (...args) => sent.push(args) },
  });
  const sent = []; const notices = []; const shortcuts = new Map(); const progress = [];
  const trayImages = []; const tooltips = [];
  const auxiliary = {
    inactiveShows: 0,
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive() { this.inactiveShows++; },
  };
  let shown = 0;
  let trayIcon = '';
  class Tray extends EventEmitter {
    constructor(icon) { super(); trayIcon = icon.path; }
    setImage(icon) { trayImages.push(icon.path); }
    setToolTip(value) { tooltips.push(value); }
    setContextMenu() {} destroy() {} isDestroyed() { return false; }
  }
  class Notification extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    static isSupported() { return true; }
    show() { notices.push(this); }
  }
  const electron = {
    app, BrowserWindow: { getAllWindows: () => [win, auxiliary] },
    Tray, Notification, Menu: { buildFromTemplate: (value) => value },
    nativeImage: { createFromPath: (file) => ({ path: file, isEmpty: () => false, setTemplateImage() {} }) },
    globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; }, unregister: (key) => shortcuts.delete(key) },
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ id: 1, size: { width: 100, height: 80 } }) },
    desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('fixture') } }] },
    dialog: { showErrorBox: () => assert.fail('unexpected capture error') },
  };
  const controller = installDesktop({ getWindow: () => win, showWindow: () => { shown++; win.visible = true; }, electron });
  controller.bindWindow(win);
  return {
    app, win, auxiliary, sent, notices, shortcuts, controller, progress, trayImages, tooltips,
    shown: () => shown, trayIcon: () => trayIcon,
  };
}

test('托盘使用当前平台图标', () => {
  const f = fixture();
  assert.match(
    f.trayIcon(),
    process.platform === 'darwin' ? /assets[\\/]trayTemplate\.png$/ : /assets[\\/]tray\.png$/,
  );
});

test('只识别桌面完成事件，开始同步和其他会话不提醒', () => {
  assert.equal(completionKey({ event: 'turn_end', chat_id: 'desktop', turn_id: 't' }), 't');
  assert.equal(completionKey({ event: 'session_updated', chat_id: 'desktop', notification_id: 'n' }), 'n');
  assert.equal(completionKey({ event: 'session_updated', chat_id: 'desktop' }), null);
  assert.equal(completionKey({ event: 'turn_end', chat_id: 'other', turn_id: 't' }), null);
});

test('关闭隐藏到托盘，明确退出才能关闭；快捷键隐藏后恢复原应用焦点', async () => {
  const f = fixture(); let prevented = 0;
  f.win.emit('close', { preventDefault: () => prevented++ });
  assert.equal(prevented, 1); assert.equal(f.win.visible, false);
  f.shortcuts.get('CommandOrControl+Shift+E')();
  assert.equal(f.shown(), 1);
  assert.deepEqual(f.sent.at(-1), ['desktop:focus-composer']);
  f.shortcuts.get('CommandOrControl+Shift+E')();
  assert.equal(f.win.visible, false);
  if (process.platform === 'darwin') {
    assert.equal(f.app.hidden, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.auxiliary.inactiveShows, 1);
  }
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

test('直播状态切换托盘图和任务栏进度', () => {
  const f = fixture();
  f.controller.handleFrame({ event: 'goal_status', chat_id: 'desktop', status: 'running' });
  assert.match(f.trayImages.at(-1), /trayStreamingTemplate\.png$/);
  assert.equal(f.tooltips.at(-1), 'Nanobot · 正在回复');
  assert.deepEqual(f.progress.at(-1), [2, { mode: 'indeterminate' }]);
  f.controller.handleFrame({ event: 'goal_status', chat_id: 'desktop', status: 'idle' });
  assert.match(f.trayImages.at(-1), /trayTemplate\.png$/);
  f.controller.handleFrame({ event: 'companion_state', working: true });
  assert.match(f.trayImages.at(-1), /trayStreamingTemplate\.png$/);
  f.controller.handleFrame({ event: 'companion_state', working: false });
  assert.match(f.trayImages.at(-1), /trayTemplate\.png$/);
});

test('完成通知使用本轮回复正文', () => {
  const f = fixture();
  f.win.focused = false;
  f.controller.handleFrame({ event: 'delta', chat_id: 'desktop', turn_id: 't1', text: '**完成**' });
  f.controller.handleFrame({ event: 'turn_end', chat_id: 'desktop', turn_id: 't1' });
  assert.equal(f.notices.at(-1).options.body, '完成');
});

test('无 delta 时使用 stream_end 正文且不重复已有摘要', () => {
  const f = fixture();
  f.win.focused = false;
  f.controller.handleFrame({ event: 'stream_end', chat_id: 'desktop', turn_id: 't1', text: '完整回复' });
  f.controller.handleFrame({ event: 'turn_end', chat_id: 'desktop', turn_id: 't1' });
  assert.equal(f.notices.at(-1).options.body, '完整回复');

  f.controller.handleFrame({ event: 'delta', chat_id: 'desktop', turn_id: 't2', text: '流式回复' });
  f.controller.handleFrame({ event: 'stream_end', chat_id: 'desktop', turn_id: 't2', text: '流式回复' });
  f.controller.handleFrame({ event: 'turn_end', chat_id: 'desktop', turn_id: 't2' });
  assert.equal(f.notices.at(-1).options.body, '流式回复');
});

test('外部渠道完成通知使用 session_updated 摘要', () => {
  const f = fixture();
  f.win.focused = false;
  f.controller.handleFrame({ event: 'session_updated', chat_id: 'desktop', notification_id: 'external-1' });
  assert.equal(f.notices.length, 0);
  f.controller.notifyIncoming('external-1', { text: 'QQ 回复内容', hasMedia: true });
  assert.equal(f.notices.at(-1).options.body, 'QQ 回复内容');
});

test('截图只发附件事件，不发送聊天消息，并恢复窗口', async () => {
  const f = fixture();
  await f.controller.capture();
  assert.deepEqual(f.sent.map(([event]) => event), ['desktop:screenshot', 'desktop:focus-composer']);
  assert.match(f.sent[0][1], /^data:image\/jpeg;base64,/);
  assert.equal(f.win.hidden, 1); assert.equal(f.shown(), 1);
});
