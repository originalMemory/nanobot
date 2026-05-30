import { useCallback, useEffect, useState } from "react";
import { isElectron } from "@/lib/env";

/**
 * Reactive get/set for electron-store keys.
 *
 * In Electron: reads from electron-store on mount, writes via IPC on setValue.
 * In non-Electron env (tests/storybook): falls back to the provided defaultValue.
 *
 * @param key       dot-notation key, e.g. "appearance.theme"
 * @param defaultValue  fallback value used before async read completes or in non-Electron env
 */
export function useElectronPreference<T>(
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  const [value, setValueState] = useState<T>(defaultValue);

  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    window.electronAPI.config.get(key).then((stored) => {
      if (!cancelled && stored !== undefined && stored !== null) {
        setValueState(stored as T);
      }
    }).catch(() => {
      // ignore IPC errors — stay with defaultValue
    });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setValue = useCallback(
    (newValue: T) => {
      setValueState(newValue);
      if (isElectron) {
        window.electronAPI.config.set(key, newValue).catch(() => {
          // ignore IPC errors
        });
      }
    },
    [key],
  );

  return [value, setValue];
}
