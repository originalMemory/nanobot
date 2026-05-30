import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { isElectron } from "@/lib/env";

export type Theme =
  | "light"
  | "dark"
  | "midnight"
  | "desert"
  | "neon"
  | "marshmallow"
  | "ink"
  | "party"
  | "rainbow";

export const ALL_THEMES: Theme[] = [
  "light",
  "dark",
  "midnight",
  "desert",
  "neon",
  "marshmallow",
  "ink",
  "party",
  "rainbow",
];

const DARK_THEMES: Theme[] = ["dark", "midnight", "neon"];

const STORAGE_KEY = "nanobot-webui.theme";
const ELECTRON_STORE_KEY = "appearance.theme";

const ThemeContext = createContext<Theme>("light");

function isValidTheme(v: unknown): v is Theme {
  return ALL_THEMES.includes(v as Theme);
}

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isValidTheme(v) ? v : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  if (DARK_THEMES.includes(theme)) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
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

  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!isElectron) {
      hydratedRef.current = true;
      return;
    }
    window.electronAPI.config.get(ELECTRON_STORE_KEY).then((stored) => {
      if (isValidTheme(stored)) {
        setThemeState(stored);
      } else if (stored !== undefined && stored !== null) {
        window.electronAPI.config.set(ELECTRON_STORE_KEY, "light").catch(() => {});
      }
    }).catch(() => {
      // ignore
    }).finally(() => {
      hydratedRef.current = true;
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    if (!hydratedRef.current) {
      root.classList.add("no-transition");
      applyTheme(theme);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          root.classList.remove("no-transition");
        });
      });
    } else {
      applyTheme(theme);
    }

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
    () =>
      setThemeState((t) => {
        const idx = ALL_THEMES.indexOf(t);
        return ALL_THEMES[(idx + 1) % ALL_THEMES.length];
      }),
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

export function isDarkTheme(theme: Theme): boolean {
  return DARK_THEMES.includes(theme);
}
