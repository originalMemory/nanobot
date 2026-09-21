import { useSyncExternalStore } from "react";

import {
  DEFAULT_LOCAL_PREFS,
  LOCAL_PREFS_CHANGED_EVENT,
  readLocalPreferences,
  type LocalPreferences,
} from "@/lib/local-preferences";

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: boolean | undefined;

function updateSnapshot(next: boolean): void {
  if (snapshot === next) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function refreshSnapshot(): void {
  updateSnapshot(readLocalPreferences().codeWrap);
}

function refreshFromPreferenceEvent(event: Event): void {
  const detail = (event as CustomEvent<Partial<LocalPreferences> | undefined>).detail;
  updateSnapshot(
    typeof detail?.codeWrap === "boolean"
      ? detail.codeWrap
      : readLocalPreferences().codeWrap,
  );
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", refreshSnapshot);
    window.addEventListener("focus", refreshSnapshot);
    window.addEventListener(LOCAL_PREFS_CHANGED_EVENT, refreshFromPreferenceEvent);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", refreshSnapshot);
      window.removeEventListener("focus", refreshSnapshot);
      window.removeEventListener(LOCAL_PREFS_CHANGED_EVENT, refreshFromPreferenceEvent);
    }
  };
}

function getSnapshot(): boolean {
  if (snapshot === undefined || listeners.size === 0) {
    snapshot = readLocalPreferences().codeWrap;
  }
  return snapshot;
}

export function useCodeWrap(): boolean {
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_LOCAL_PREFS.codeWrap,
  );
}
