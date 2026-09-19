const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createCompanion, timeSegment } = require('../companion.cjs');

test('本地资源只通过清单 URL 读取，支持 Range 和场景时段回退', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nanobot-companion-'));
  try {
    const bundledRoot = path.join(root, 'bundled');
    const pack = path.join(root, 'scene');
    for (const folder of [bundledRoot, path.join(pack, 'idle', 'day'), path.join(pack, 'working')]) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(bundledRoot, '待机-呼吸.mp4'), '0123456789');
    await fs.writeFile(path.join(bundledRoot, '工作-思考中.mp4'), 'work');
    await fs.writeFile(path.join(pack, 'idle', 'day', 'scene.mp4'), 'scene');
    const api = createCompanion({ directory: root, bundledRoot, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [pack] }) } });
    assert.equal((await api.read()).enabled, false);
    await assert.rejects(api.save({ directory: pack }), /desktop dialog/);
    const selected = await api.choose();
    await Promise.all([api.save({ enabled: true }), api.save({ directory: selected })]);
    assert.equal((await api.read()).enabled, true);
    const videos = await api.videos(new Date(2026, 8, 19, 12));
    assert.equal(videos.segment, 'day');
    assert.equal(videos.idle.length, 1);
    assert.notEqual(videos.idle[0], videos.fallback.idle[0]);
    assert.deepEqual(videos.working, videos.fallback.working);
    const response = await api.serve(new Request(videos.fallback.idle[0], { headers: { range: 'bytes=2-5' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');
    assert.equal((await api.serve(new Request(videos.idle[0], { headers: { range: 'bytes=99-' } }))).status, 416);
    assert.equal((await api.serve(new Request('nanobot://desktop/companion-video/unlisted'))).status, 404);
    await assert.rejects(api.save({ schedule: { day: '99:00' } }), /Invalid time/);
    await api.save({ panel: { width: 5000, collapsed: true } });
    const restored = createCompanion({ directory: root, bundledRoot, dialog: {} });
    assert.equal((await restored.read()).panel.width, 1120);
    assert.equal((await restored.read()).panel.collapsed, true);
    assert.equal(timeSegment(new Date(2026, 8, 19, 2)), 'night');
  } finally { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "nanobot-companion-")); await fs.rm(root, { recursive: true, force: true }); }
});
