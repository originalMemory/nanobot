const path = require('node:path');
const { createReadStream } = require('node:fs');
const { readFile, readdir, realpath, stat } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');

const SCHEDULE = { sunrise: '05:00', day: '10:00', sunset: '18:00', night: '22:00' };
const DEFAULTS = { enabled: false, directory: '', scene: '', schedule: SCHEDULE, panel: { x: null, y: null, width: 288, collapsed: false } };

// 沿用 lover 的时段选择及场景目录结构。
function timeSegment(now, schedule = SCHEDULE) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const entries = Object.entries(schedule).map(([key, value]) => {
    const [h, m] = value.split(':').map(Number); return [key, h * 60 + m];
  }).sort((a, b) => a[1] - b[1]);
  return (entries.filter(([, start]) => start <= minutes).at(-1) ?? entries.at(-1))[0];
}

function normalize(raw = {}) {
  const panel = { ...DEFAULTS.panel, ...raw.panel };
  if (typeof raw.enabled !== 'boolean' || typeof raw.directory !== 'string' || raw.directory.length > 4096) throw new Error('Invalid companion preferences');
  if (typeof raw.scene !== 'string' || raw.scene.length > 255 || /[\\/]/.test(raw.scene) || raw.scene === '..') throw new Error('Invalid video scene');
  if (typeof panel.collapsed !== 'boolean' || !Number.isFinite(panel.width)) throw new Error('Invalid panel');
  for (const key of ['x', 'y']) if (panel[key] !== null && !Number.isFinite(panel[key])) throw new Error('Invalid position');
  panel.width = Math.max(200, Math.min(1120, Math.round(panel.width)));
  const schedule = { ...SCHEDULE, ...raw.schedule };
  for (const key of Object.keys(SCHEDULE)) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule[key])) throw new Error('Invalid time');
  return { enabled: raw.enabled, directory: raw.directory.trim(), scene: raw.scene.trim(), panel,
    schedule: Object.fromEntries(Object.keys(SCHEDULE).map(key => [key, schedule[key]])) };
}

function createCompanion({ store, bundledRoot, dialog }) {
  let chosenDirectory; let saving = Promise.resolve();
  const files = new Map();
  const isPack = async folder => (await stat(path.join(folder, 'idle')).catch(() => null))?.isDirectory()
    && (await stat(path.join(folder, 'working')).catch(() => null))?.isDirectory();
  async function packInfo(folder, id) {
    if (!await isPack(folder)) return null;
    const root = await realpath(folder);
    let displayName = id === '.' ? path.basename(root) : id;
    try {
      const manifestPath = path.join(root, 'manifest.json');
      const info = await stat(manifestPath);
      if (info.isFile() && info.size <= 64 * 1024) {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (typeof manifest.displayName === 'string' && manifest.displayName.trim()) {
          displayName = manifest.displayName.trim().slice(0, 100);
        }
      }
    } catch { /* Use the directory name when metadata is absent or invalid. */ }
    return { id, displayName, root };
  }
  async function discover(root) {
    const canonicalRoot = await realpath(root);
    const direct = await packInfo(canonicalRoot, '.');
    if (direct) return [direct];
    const results = [];
    const children = await readdir(canonicalRoot, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory()) continue;
      const pack = await packInfo(path.join(canonicalRoot, child.name), child.name);
      if (pack && pack.root.startsWith(canonicalRoot + path.sep)) results.push(pack);
    }
    return results;
  }
  async function read() {
    const saved = store.get('avatarCompanion', {});
    const prefs = normalize({ ...DEFAULTS, ...saved, directory: saved.videoDirectory ?? '', scene: saved.videoScene ?? '',
      schedule: saved.timeSchedule ?? SCHEDULE });
    if (prefs.directory && !prefs.scene) {
      const available = await discover(prefs.directory).catch(() => []);
      if (available.length === 1) prefs.scene = available[0].id;
    }
    return prefs;
  }
  function save(patch) {
    const operation = saving.then(async () => {
      const previous = await read();
      const next = normalize({ ...previous, ...patch, panel: { ...previous.panel, ...patch.panel } });
      if (next.directory && next.directory !== previous.directory && next.directory !== chosenDirectory) throw new Error('Choose a video folder using the desktop dialog');
      if (next.directory) {
        const available = await discover(next.directory);
        const selected = available.find(pack => pack.id === next.scene)
          ?? (!next.scene && available.length === 1 ? available[0] : null);
        if (!selected) throw new Error('Choose an available video scene');
        next.scene = selected.id;
      } else next.scene = '';
      store.set('avatarCompanion', { ...store.get('avatarCompanion', {}), enabled: next.enabled,
        videoDirectory: next.directory, videoScene: next.scene, timeSchedule: next.schedule, panel: next.panel });
      if (previous.directory !== next.directory || previous.scene !== next.scene) files.clear();
      return structuredClone(next);
    });
    saving = operation.catch(() => {});
    return operation;
  }
  async function choose() {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    chosenDirectory = await realpath(result.filePaths[0]);
    return chosenDirectory;
  }
  async function packs(directory) {
    if (typeof directory !== 'string' || directory.length > 4096) throw new Error('Invalid video directory');
    if (!directory) return [];
    const root = await realpath(directory);
    const saved = store.get('avatarCompanion.videoDirectory', '');
    const savedRoot = saved ? await realpath(saved).catch(() => '') : '';
    if (root !== chosenDirectory && root !== savedRoot) throw new Error('Choose a video folder using the desktop dialog');
    return (await discover(root)).map(({ id, displayName }) => ({ id, displayName }));
  }
  async function list(folder, root, prefix = '') {
    try {
      const canonicalRoot = await realpath(root);
      const results = [];
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (!item.isFile() || !/\.(mp4|webm|mov)$/i.test(item.name) || !item.name.startsWith(prefix)) continue;
        const file = await realpath(path.join(folder, item.name));
        if (!file.startsWith(canonicalRoot + path.sep)) continue;
        const id = createHash('sha256').update(file).digest('hex');
        files.set(id, { file, root: canonicalRoot });
        results.push(`nanobot://desktop/companion-video/${id}`);
      }
      return results.sort();
    } catch { return []; }
  }
  async function videos(now = new Date()) {
    const prefs = await read(); const segment = timeSegment(now, prefs.schedule);
    let root = ''; let error = false;
    if (prefs.directory) {
      const available = await discover(prefs.directory).catch(() => []);
      const selected = available.find(pack => pack.id === prefs.scene)
        ?? (!prefs.scene && available.length === 1 ? available[0] : null);
      if (selected) root = selected.root;
      else error = true;
    }
    const result = { idle: [], working: [], fallback: {}, segment, error };
    for (const mode of ['idle', 'working']) {
      if (root) result[mode] = await list(path.join(root, mode, segment), root);
      if (!result[mode].length && root) result[mode] = await list(path.join(root, mode), root);
      result.fallback[mode] = await list(bundledRoot, bundledRoot, mode === 'working' ? '工作-' : '待机-');
      if (!result[mode].length) result[mode] = result.fallback[mode];
    }
    return result;
  }
  async function serve(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const entry = files.get(new URL(request.url).pathname.split('/').at(-1));
    if (!entry) return new Response(null, { status: 404 });
    try {
      const file = await realpath(entry.file);
      if (file !== entry.file || !file.startsWith(entry.root + path.sep)) return new Response(null, { status: 403 });
      const info = await stat(file); const size = info.size;
      if (!info.isFile() || !size) return new Response(null, { status: 404 });
      let start = 0; let end = size - 1;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      }
      const headers = { 'content-type': path.extname(file).toLowerCase() === '.webm' ? 'video/webm' : path.extname(file).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4',
        'accept-ranges': 'bytes', 'content-length': String(end - start + 1) };
      if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
      if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
      return new Response(Readable.toWeb(createReadStream(file, { start, end })), { status: range ? 206 : 200, headers });
    } catch { return new Response(null, { status: 404 }); }
  }
  return { read, save, choose, packs, videos, serve };
}
module.exports = { createCompanion, timeSegment, normalize };
