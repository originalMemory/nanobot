const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SystemMediaController } = require('../system-media.cjs');

test('语音播放暂停媒体默认开启，保留用户明确关闭的设置', () => {
  assert.equal(new SystemMediaController({ get: () => undefined, set() {} }, 'linux').getEnabled(), true);
  assert.equal(new SystemMediaController({ get: () => false, set() {} }, 'linux').getEnabled(), false);
});

test('复用 lover 媒体暂停/恢复，多个播放来源结束前不恢复', async () => {
  const calls = [];
  const controller = new SystemMediaController({ get: () => true, set() {} }, 'win32', async (file, args) => {
    assert.equal(file, 'powershell.exe');
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const pause = script.includes('TryPauseAsync');
    calls.push(pause ? 'pause' : 'resume');
    return pause ? 'paused-session' : '[]';
  }, null);
  await controller.setTtsActive(1, true);
  await controller.setTtsActive(2, true);
  await controller.setTtsActive(1, false);
  assert.deepEqual(calls, ['pause']);
  await controller.setTtsActive(2, false);
  assert.deepEqual(calls, ['pause', 'resume']);
  await controller.dispose();
});
