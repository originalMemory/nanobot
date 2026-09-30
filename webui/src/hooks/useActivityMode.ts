import { useEffect, useState } from "react";
import { LOCAL_PREFS_CHANGED_EVENT, readLocalPreferences, type LocalActivityMode, type LocalPreferences } from "@/lib/local-preferences";

export function useActivityMode(): LocalActivityMode {
  const [mode, setMode] = useState<LocalActivityMode>(() => readLocalPreferences().activityMode);
  useEffect(() => {
    const refresh = () => setMode(readLocalPreferences().activityMode);
    const refreshFromPreferenceEvent = (event: Event) => {
      const detail = (event as CustomEvent<Partial<LocalPreferences> | undefined>).detail;
      setMode(detail?.activityMode === "expanded" ? "expanded" : detail?.activityMode === "auto" ? "auto" : readLocalPreferences().activityMode);
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
  return mode;
}
