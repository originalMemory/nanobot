import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  listWallpaperImages,
  localWallpaperCandidateIndices,
  wallpaperFileToDataUrl,
  wallpaperDirectoryKey,
} from './wallpaper';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('local wallpaper rotation', () => {
  it('lists supported files from the directory root in stable numeric order', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nanobot-wallpaper-'));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, 'image10.JPG'), 'ten'),
      writeFile(path.join(directory, 'image2.png'), 'two'),
      writeFile(path.join(directory, 'notes.txt'), 'ignored'),
    ]);

    const files = await listWallpaperImages(directory);

    expect(files.map((file) => path.basename(file))).toEqual(['image2.png', 'image10.JPG']);
  });

  it('continues sequentially after the persisted index and wraps', () => {
    expect(localWallpaperCandidateIndices(4, 2, 'sequential')).toEqual([3, 0, 1, 2]);
    expect(localWallpaperCandidateIndices(3, -1, 'sequential')).toEqual([0, 1, 2]);
  });

  it('does not immediately repeat the previous random image', () => {
    const indices = localWallpaperCandidateIndices(4, 2, 'random', () => 0);
    expect(indices[0]).not.toBe(2);
    expect(indices.at(-1)).toBe(2);
    expect([...indices].sort()).toEqual([0, 1, 2, 3]);
  });

  it('encodes local images as data URLs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nanobot-wallpaper-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'wallpaper.png');
    await writeFile(file, Buffer.from([1, 2, 3]));

    await expect(wallpaperFileToDataUrl(file)).resolves.toBe('data:image/png;base64,AQID');
  });

  it('normalizes equivalent directory spellings before deciding to reset the index', () => {
    expect(wallpaperDirectoryKey('C:/Pictures/Nanobot/', 'win32'))
      .toBe(wallpaperDirectoryKey('c:\\pictures\\nanobot', 'win32'));
    expect(wallpaperDirectoryKey('/Users/me/Pictures/', 'darwin'))
      .toBe(wallpaperDirectoryKey('/Users/me/Pictures', 'darwin'));
    expect(wallpaperDirectoryKey('/Users/me/Other', 'darwin'))
      .not.toBe(wallpaperDirectoryKey('/Users/me/Pictures', 'darwin'));
  });
});
