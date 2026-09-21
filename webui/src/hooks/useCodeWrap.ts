import { useEffect, useState } from "react";

import {
  LOCAL_PREFS_CHANGED_EVENT,
  readLocalPreferences,
  type LocalPreferences,
} from "@/lib/local-preferences";

export function useCodeWrap(): boolean {
  const [wrap, setWrap] = useState(() => readLocalPreferences().codeWrap);

  useEffect(() => {
    const refresh = () => setWrap(readLocalPreferences().codeWrap);
    const refreshFromPreferenceEvent = (event: Event) => {
      const detail = (event as CustomEvent<Partial<LocalPreferences> | undefined>).detail;
      setWrap(typeof detail?.codeWrap === "boolean" ? detail.codeWrap : readLocalPreferences().codeWrap);
    };
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(LOCAL_PREFS_CHANGED_EVENT, refreshFromPreferenceEvent);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(LOCAL_PREFS_CHANGED_EVENT, refreshFromPreferenceEvent);
    };
  }, []);

  return wrap;
}
