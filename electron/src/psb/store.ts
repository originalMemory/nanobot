import type Store from 'electron-store';

import { DEFAULT_PSB_LOCAL_PREFS, type DeskPetLocalPrefs, type PsbWindowState } from './types';

export type ElectronConfigStore = Pick<Store<unknown>, 'get' | 'set'>;

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
  store.set('deskPet.psb.window', next);
  return next;
}

export function setPsbTemporarilyClosed(store: ElectronConfigStore, closed: boolean): void {
  store.set('deskPet.psb.temporarilyClosed', closed);
}

export function clearPsbSessionClose(store: ElectronConfigStore): void {
  setPsbTemporarilyClosed(store, false);
}
