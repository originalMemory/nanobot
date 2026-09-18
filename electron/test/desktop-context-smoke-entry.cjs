// 仅供隔离冒烟：替换系统采集器，不读取真实屏幕。
const { app, BrowserWindow, desktopCapturer, powerMonitor, screen, nativeImage } = require('electron');
app.whenReady().then(() => {
  BrowserWindow.getFocusedWindow = () => null;
  powerMonitor.getSystemIdleState = () => 'active';
  desktopCapturer.getSources = async () => screen.getAllDisplays().map((display) => ({
    display_id: String(display.id),
    thumbnail: nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR4nO3PsQ2AQBDEwO+/FNogpghimqABLiDyW7K0oYOd9VzH547z/txu/drtUAD6UAD6UAD60G+A5ejUB6D7AHQfgO79AMvRqQ9A9wHoPgDd+wGWo1MfgO4D0H0AuvcDLEenPgDdB6D7AHTvB1iOTn0Aug9A9wHo3g+wHJ36AHQfgO4D0L0fYDk69QHoPgDdB6B7PeAFhauCLAGKqwYAAAAASUVORK5CYII=', 'base64')),
  }));
});
require('../main.cjs');
