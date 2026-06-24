import type Store from 'electron-store';

import { DEFAULT_PSB_LOCAL_PREFS, type DeskPetLocalPrefs, type PsbWindowState } from './types';

export type ElectronConfigStore = Pick<Store<unknown>, 'get' | 'set'>;

export const PSB_WINDOW_SIZE_MIN = 240;
export const PSB_WINDOW_SIZE_MAX = 2400;
export const PSB_OPACITY_MIN = 0.2;
export const PSB_OPACITY_MAX = 1;

export function clampPsbWindowSize(value: number): number {
  return Math.max(PSB_WINDOW_SIZE_MIN, Math.min(PSB_WINDOW_SIZE_MAX, Math.floor(value)));
}

export function clampPsbOpacity(value: number): number {
  return Math.max(PSB_OPACITY_MIN, Math.min(PSB_OPACITY_MAX, Math.round(value * 100) / 100));
}

export function readDeskPetPrefs(store: ElectronConfigStore): DeskPetLocalPrefs {
  const stored = store.get('deskPet') as DeskPetLocalPrefs | undefined;
  const defaults = DEFAULT_PSB_LOCAL_PREFS.psb;
  const window = stored?.psb?.window ?? defaults.window;
  return {
    psb: {
      window: {
        x: window.x,
        y: window.y,
        width: window.width ?? defaults.window.width,
        height: window.height ?? defaults.window.height,
        scale: window.scale ?? defaults.window.scale,
        opacity: window.opacity ?? defaults.window.opacity,
      },
      temporarilyClosed: stored?.psb?.temporarilyClosed ?? false,
    },
  };
}

export function writePsbWindowState(
  store: ElectronConfigStore,
  patch: Partial<PsbWindowState>,
): PsbWindowState {
  const current = readDeskPetPrefs(store).psb.window;
  const next: PsbWindowState = {
    ...current,
    ...patch,
  };
  if (patch.width !== undefined) {
    next.width = clampPsbWindowSize(patch.width);
  }
  if (patch.height !== undefined) {
    next.height = clampPsbWindowSize(patch.height);
  }
  if (patch.opacity !== undefined) {
    next.opacity = clampPsbOpacity(patch.opacity);
  }
  store.set('deskPet.psb.window', next);
  return next;
}

export function setPsbTemporarilyClosed(store: ElectronConfigStore, closed: boolean): void {
  store.set('deskPet.psb.temporarilyClosed', closed);
}

export function clearPsbSessionClose(store: ElectronConfigStore): void {
  setPsbTemporarilyClosed(store, false);
}
