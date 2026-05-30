import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { isElectron } from "@/lib/env";

type Theme = "light" | "dark";
const STORAGE_KEY = "nanobot-webui.theme";
const ELECTRON_STORE_KEY = "appearance.theme";
const ThemeContext = createContext<Theme>("light");

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readStored();
    if (stored) return stored;
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light";
  });

  // On mount in Electron, try to read from electron-store (overrides localStorage value)
  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.config.get(ELECTRON_STORE_KEY).then((stored) => {
      if (stored === "light" || stored === "dark") {
        setThemeState(stored);
      }
    }).catch(() => {
      // ignore
    });
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (isElectron) {
      window.electronAPI.config.set(ELECTRON_STORE_KEY, theme).catch(() => {});
    } else {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // ignore
      }
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    [],
  );
  return { theme, toggle, setTheme };
}

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useThemeValue(): Theme {
  return useContext(ThemeContext);
}
