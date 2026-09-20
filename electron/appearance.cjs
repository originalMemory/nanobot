const path = require('node:path');
const { readFile, readdir, realpath, stat } = require('node:fs/promises');
const MAX_IMAGE = 12 * 1024 * 1024;
const DEFAULTS = {
  source: 'none', url: '', directory: '', order: 'sequential', intervalMinutes: 5,
  opacity: 0.8, contentWidth: 1152,
};

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid appearance settings');
  const result = { ...DEFAULTS };
  for (const [key, max] of [['url', 2048], ['directory', 4096]]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > max) throw new Error(`Invalid ${key}`);
    result[key] = value[key].trim();
  }
  for (const [key, choices] of [['source', ['none', 'url', 'directory']], ['order', ['sequential', 'random']]]) {
    if (value[key] !== undefined && !choices.includes(value[key])) throw new Error(`Invalid ${key}`);
    result[key] = value[key] ?? DEFAULTS[key];
  }
  for (const [key, min, max] of [['intervalMinutes', 1, 1440], ['opacity', 0.5, 1]]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) {
      if (result.source === 'none') continue; // Hidden wallpaper controls fall back to defaults.
      throw new Error(`Invalid ${key}`);
    }
    result[key] = value[key];
  }
  if (value.contentWidth !== undefined) {
    if (!Number.isInteger(value.contentWidth) || value.contentWidth < 640 || value.contentWidth > 1440) {
      throw new Error('Invalid contentWidth');
    }
    result.contentWidth = value.contentWidth;
  }
  if (result.url) {
    try {
      const url = new URL(result.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) image URL without credentials');
    } catch (error) {
      if (result.source === 'url') throw error;
      result.url = ''; // Do not let an inactive URL block disabling or switching sources.
    }
  }
  if (result.source === 'url' && !result.url) throw new Error('Choose an image URL');
  if (result.source === 'directory' && !result.directory) throw new Error('Choose an image folder');
  return result;
}

async function boundedImage(response) {
  if (!response.ok || !/^image\/(png|jpe?g|webp|gif|bmp|avif)(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Could not load image');
  if (Number(response.headers.get('content-length')) > MAX_IMAGE) { await response.body?.cancel(); throw new Error('Image too large'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE) throw new Error('Image too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createAppearance({ store, nativeImage, dialog, fetchImage = fetch }) {
  let config; let selectedDirectory; let lastFile = '';
  let saving = Promise.resolve();
  async function read() {
    if (!config) {
      const appearance = store.get('appearance', {});
      const wallpaper = appearance.wallpaper ?? {};
      config = normalize({
        ...wallpaper,
        opacity: appearance.opacity,
        contentWidth: appearance.contentWidth,
        order: wallpaper.localOrder,
      });
    }
    return { ...config };
  }
  function encode(buffer) {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('Unsupported or damaged image');
    const size = image.getSize(); const max = 2560;
    const scaled = Math.max(size.width, size.height) > max
      ? image.resize(size.width >= size.height ? { width: max } : { height: max }) : image;
    return `data:image/jpeg;base64,${scaled.toJPEG(85).toString('base64')}`;
  }
  async function localImage(filePath) {
    if ((await stat(filePath)).size > MAX_IMAGE) throw new Error('Image too large');
    const buffer = await readFile(filePath);
    if (buffer.length > MAX_IMAGE) throw new Error('Image too large');
    return encode(buffer);
  }
  function save(value) {
    const operation = saving.then(async () => {
      const previous = await read(); const next = normalize(value);
      if (next.directory && next.directory !== previous.directory && next.directory !== selectedDirectory) throw new Error('Choose the folder through the desktop dialog');
      store.set({ 'appearance.opacity': next.opacity, 'appearance.contentWidth': next.contentWidth, 'appearance.wallpaper': {
          ...store.get('appearance.wallpaper', {}), source: next.source, url: next.url,
          directory: next.directory, localOrder: next.order, intervalMinutes: next.intervalMinutes,
        } });
      if (next.directory !== previous.directory) lastFile = '';
      config = next;
      return { ...next };
    });
    saving = operation.catch(() => {});
    return operation;
  }
  async function choose(kind, window) {
    if (kind !== 'directory') throw new Error('Invalid image selection');
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    selectedDirectory = await realpath(result.filePaths[0]);
    return selectedDirectory;
  }
  async function wallpaper() {
    const current = await read();
    if (current.source === 'none') return null;
    if (current.source === 'url') {
      // Fetch without gateway cookies or credentials; return pixels, never remote HTML/SVG.
      return encode(await boundedImage(await fetchImage(current.url, { signal: AbortSignal.timeout(15000), credentials: 'omit' })));
    }
    const root = await realpath(current.directory);
    const files = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif|bmp)$/i.test(entry.name))
      .map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const start = files.indexOf(lastFile);
    let candidates = [...files.slice(start + 1), ...files.slice(0, start + 1)];
    if (current.order === 'random') {
      candidates = files.filter((name) => name !== lastFile);
      for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
      if (files.includes(lastFile)) candidates.push(lastFile);
    }
    for (const name of candidates) {
      try {
        const candidate = await realpath(path.join(root, name));
        if (path.dirname(candidate) !== root) continue;
        const data = await localImage(candidate); lastFile = name; return data;
      } catch { /* Skip damaged or removed files and try another image. */ }
    }
    throw new Error('No readable images in the selected folder');
  }
  return { read, save, choose, wallpaper };
}
module.exports = { createAppearance, normalize, boundedImage, DEFAULTS };
