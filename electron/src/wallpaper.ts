import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type WallpaperSource = 'url' | 'directory';
export type WallpaperLocalOrder = 'sequential' | 'random';

export interface WallpaperConfig {
  source: WallpaperSource;
  url: string;
  directory: string;
  localOrder: WallpaperLocalOrder;
  localIndex: number;
  intervalMinutes: number;
}

export function wallpaperDirectoryKey(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const value = directory.trim();
  if (!value) return '';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let normalized = pathApi.normalize(value);
  const rootLength = pathApi.parse(normalized).root.length;
  while (normalized.length > rootLength && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function listWallpaperImages(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() in IMAGE_MIME_TYPES)
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/** 返回本轮尝试顺序；首项为下一张，后续项用于跳过损坏或不可读文件。 */
export function localWallpaperCandidateIndices(
  count: number,
  lastIndex: number,
  order: WallpaperLocalOrder,
  random: () => number = Math.random,
): number[] {
  if (count <= 0) return [];
  const normalizedLast = Number.isInteger(lastIndex) && lastIndex >= 0
    ? lastIndex % count
    : -1;

  if (order === 'sequential') {
    const start = normalizedLast < 0 ? 0 : (normalizedLast + 1) % count;
    return Array.from({ length: count }, (_, offset) => (start + offset) % count);
  }

  const candidates = Array.from({ length: count }, (_, index) => index)
    .filter((index) => index !== normalizedLast);
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  if (normalizedLast >= 0) candidates.push(normalizedLast);
  return candidates;
}

export async function wallpaperFileToDataUrl(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) throw new Error(`unsupported image type: ${extension}`);
  const buffer = await readFile(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}
