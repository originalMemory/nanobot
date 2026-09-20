const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, mkdir, rm, symlink } = require('node:fs/promises');
const os = require('node:os');
const Store = require('electron-store');
const path = require('node:path');
const { createAppearance, normalize, boundedImage, DEFAULTS } = require('../appearance.cjs');

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nanobot-appearance-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let selection;
  const nativeImage = { createFromBuffer: (buffer) => ({
    isEmpty: () => !buffer.toString().startsWith('good'), getSize: () => ({ width: 100, height: 100 }),
    toJPEG: () => buffer,
  }) };
  const store = new Store({ cwd: directory, projectVersion: '0.3.5' });
  const options = { store, nativeImage, dialog: { showOpenDialog: async () => selection ?? { canceled: true, filePaths: [] } } };
  return { directory, options, api: createAppearance(options), select: (file) => { selection = { canceled: false, filePaths: [file] }; } };
}

test('appearance validates bounds, URLs and image payloads', () => {
  assert.equal(normalize({}).source, 'none');
  for (const patch of [{ contentWidth: 639 }, { contentWidth: 1441 }, { contentWidth: 900.5 }, { source: 'url', url: 'https://example.com/image', opacity: 0 }, { source: 'url', url: 'https://example.com/image', intervalMinutes: NaN }, { source: 'other' }, { source: 'url' }, { source: 'url', url: 'file:///etc/passwd' }, { source: 'url', url: 'https://a:b@example.com/' }]) {
    assert.throws(() => normalize({ ...DEFAULTS, ...patch }));
  }
});

test('reads lover wallpaper keys and preserves unrelated store settings', async (t) => {
  const f = await fixture(t);
  f.options.store.set({ gateway: { url: 'http://nas:8765', token: 'unchanged' },
    appearance: { theme: 'ink', wallpaper: { source: 'url', url: 'https://example.com/image', localOrder: 'random', intervalMinutes: 3, localIndex: 7 } } });
  const value = await f.api.read();
  assert.equal(value.order, 'random'); assert.equal(value.intervalMinutes, 3);
  await f.api.save({ ...value, opacity: 0.7, contentWidth: 960 });
  const reopened = new Store({ cwd: f.directory, projectVersion: '0.3.5' });
  assert.equal(reopened.get('appearance.theme'), 'ink');
  assert.equal(reopened.get('appearance.contentWidth'), 960);
  assert.equal(reopened.get('appearance.wallpaper.localOrder'), 'random');
  assert.equal(reopened.get('appearance.wallpaper.localIndex'), 7);
  assert.equal(reopened.get('gateway.url'), 'http://nas:8765');
  assert.equal(reopened.get('gateway.token'), 'unchanged');
});

test('only dialog-selected folders can be saved; legacy avatar data is ignored', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.api.save({ ...DEFAULTS, directory: '/etc' }));
  await assert.rejects(f.api.choose('avatar'));
  assert.equal(await f.api.choose('directory'), null);
  f.select(f.directory); const directory = await f.api.choose('directory');
  await f.api.save({ ...DEFAULTS, directory, avatar: 'legacy-inline-image' });
  const saved = await createAppearance(f.options).read();
  assert.equal(saved.directory, directory);
  assert.equal(Object.hasOwn(saved, 'avatar'), false);
});

test('directory rotation skips damaged files and symlinks, wraps in numeric order', async (t) => {
  const f = await fixture(t); const images = path.join(f.directory, 'images'); await mkdir(images);
  await writeFile(path.join(images, '1.png'), 'broken');
  await writeFile(path.join(images, '2.png'), 'good-two');
  await writeFile(path.join(images, '10.png'), 'good-ten');
  const outside = path.join(f.directory, 'outside.png'); await writeFile(outside, 'good-private');
  await symlink(outside, path.join(images, '3.png'));
  f.select(images); const directory = await f.api.choose('directory');
  await f.api.save({ ...DEFAULTS, source: 'directory', directory });
  const decode = async () => Buffer.from((await f.api.wallpaper()).split(',')[1], 'base64').toString();
  assert.equal(await decode(), 'good-two'); assert.equal(await decode(), 'good-ten'); assert.equal(await decode(), 'good-two');
  await f.api.save({ ...(await f.api.read()), order: 'random' });
  assert.equal(await decode(), 'good-ten');
  await f.api.save({ ...(await f.api.read()), source: 'none' }); assert.equal(await f.api.wallpaper(), null);
});

test('network wallpapers reject non-images and oversized streams', async (t) => {
  const f = await fixture(t);
  const api = createAppearance({ ...f.options, fetchImage: async (_url, options) => {
    assert.equal(options.credentials, 'omit'); return new Response('good-network', { headers: { 'content-type': 'image/png' } });
  } });
  await api.save({ ...DEFAULTS, source: 'url', url: 'https://example.com/wallpaper' });
  assert.match(await api.wallpaper(), /^data:image\/jpeg;base64,/);
  await assert.rejects(boundedImage(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })));
  await assert.rejects(boundedImage(new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } })));
  await assert.rejects(boundedImage(new Response('tiny', { headers: { 'content-type': 'image/png', 'content-length': String(13 * 1024 * 1024) } })));
  await assert.rejects(boundedImage(new Response(Buffer.alloc(13 * 1024 * 1024), { headers: { 'content-type': 'image/png' } })));
});

test('inactive wallpaper fields cannot block saving identity, disabling, or switching source', async (t) => {
  const f = await fixture(t);
  const disabled = await f.api.save({ ...DEFAULTS, source: 'none', url: 'bad-url', intervalMinutes: 0, opacity: NaN });
  assert.equal(disabled.url, '');
  assert.equal(disabled.intervalMinutes, DEFAULTS.intervalMinutes);
  assert.equal(disabled.opacity, DEFAULTS.opacity);
  assert.deepEqual(await createAppearance(f.options).read(), disabled);
  f.select(f.directory); const directory = await f.api.choose('directory');
  const local = await f.api.save({ ...disabled, source: 'directory', directory, url: 'file:///private' });
  assert.equal(local.url, ''); assert.equal(local.source, 'directory');
  const retained = normalize({ ...DEFAULTS, source: 'none', url: 'https://example.com/image', intervalMinutes: 12 });
  assert.equal(retained.url, 'https://example.com/image'); assert.equal(retained.intervalMinutes, 12);
});
