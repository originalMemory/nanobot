function readWindowState(store, screen) {
  const saved = store.get('window');
  const valid = saved && ['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(saved[key]))
    && saved.width > 0 && saved.height > 0;
  const area = (valid && screen.getAllDisplays().find(({ workArea: a }) =>
    saved.x >= a.x && saved.y >= a.y && saved.x < a.x + a.width - 60 && saved.y < a.y + a.height - 30
  ) || screen.getPrimaryDisplay()).workArea;
  const width = Math.min(Math.max(valid ? saved.width : 1200, 760), area.width);
  const height = Math.min(Math.max(valid ? saved.height : 820, 540), area.height);
  return {
    x: valid ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : area.x + Math.round((area.width - width) / 2),
    y: valid ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : area.y + Math.round((area.height - height) / 2),
    width, height, maximized: Boolean(valid && saved.maximized === true),
  };
}

function trackWindowState(win, store) {
  let timer;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    try {
      store.set('window', state);
    } catch (error) { console.warn('无法保存窗口位置。', error.message); }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 300); };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize']) win.on(event, schedule);
  win.on('close', save);
  win.on('hide', save);
  win.on('closed', () => clearTimeout(timer));
  return save;
}

module.exports = { readWindowState, trackWindowState };
