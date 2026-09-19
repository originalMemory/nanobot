const path = require('node:path');
const { createReadStream } = require('node:fs');
const { readFile, writeFile, mkdir, rename, readdir, realpath, stat } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');

const SCHEDULE = { sunrise: '05:00', day: '10:00', sunset: '18:00', night: '22:00' };
const DEFAULTS = { enabled: false, directory: '', schedule: SCHEDULE, panel: { x: null, y: null, width: 288, collapsed: false } };

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
  if (typeof panel.collapsed !== 'boolean' || !Number.isFinite(panel.width)) throw new Error('Invalid panel');
  for (const key of ['x', 'y']) if (panel[key] !== null && !Number.isFinite(panel[key])) throw new Error('Invalid position');
  panel.width = Math.max(200, Math.min(1120, Math.round(panel.width)));
  const schedule = { ...SCHEDULE, ...raw.schedule };
  for (const key of Object.keys(SCHEDULE)) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule[key])) throw new Error('Invalid time');
  return { enabled: raw.enabled, directory: raw.directory.trim(), panel, schedule: Object.fromEntries(Object.keys(SCHEDULE).map(key => [key, schedule[key]])) };
}

function createCompanion({ directory, bundledRoot, dialog }) {
  const configFile = path.join(directory, 'companion.json');
  let config; let chosenDirectory; let saving = Promise.resolve();
  const files = new Map();
  async function read() {
    if (!config) {
      try { config = normalize(JSON.parse(await readFile(configFile, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; config = normalize(DEFAULTS); }
    }
    return structuredClone(config);
  }
  function save(patch) {
    const operation = saving.then(async () => {
      const previous = await read();
      const next = normalize({ ...previous, ...patch, panel: { ...previous.panel, ...patch.panel } });
      if (next.directory && next.directory !== previous.directory && next.directory !== chosenDirectory) throw new Error('Choose a video folder using the desktop dialog');
      await mkdir(directory, { recursive: true });
      await writeFile(`${configFile}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${configFile}.tmp`, configFile);
      config = next;
      if (previous.directory !== next.directory) files.clear();
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
    let root = prefs.directory; let error = false;
    const isPack = async folder => (await stat(path.join(folder, 'idle')).catch(() => null))?.isDirectory()
      && (await stat(path.join(folder, 'working')).catch(() => null))?.isDirectory();
    if (root && !await isPack(root)) {
      const children = await readdir(root, { withFileTypes: true }).catch(() => []);
      const packs = [];
      for (const child of children) if (child.isDirectory() && await isPack(path.join(root, child.name))) packs.push(path.join(root, child.name));
      if (packs.length === 1) root = packs[0];
      else { root = ''; error = true; }
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
  return { read, save, choose, videos, serve };
}
module.exports = { createCompanion, timeSegment, normalize };
