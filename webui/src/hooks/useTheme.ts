import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";
export const THEME_CHOICES = ["light", "dark", "midnight", "desert", "neon", "marshmallow", "ink", "party", "rainbow"] as const;
export type ThemeChoice = typeof THEME_CHOICES[number];
function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.some((choice) => choice === value);
}
function themeMode(theme: ThemeChoice): Theme {
  return theme === "dark" || theme === "midnight" || theme === "neon" ? "dark" : "light";
}
const STORAGE_KEY = "nanobot-webui.theme";
const ThemeContext = createContext<Theme>("light");

function readStored(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isThemeChoice(v) ? v : null;
  } catch {
    return null;
  }
}

function applyTheme(selectedTheme: ThemeChoice): void {
  const theme = themeMode(selectedTheme);
  document.documentElement.dataset.theme = selectedTheme;
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const color =
    theme === "dark"
      ? themeColor?.dataset.themeColorDark
      : themeColor?.dataset.themeColorLight;
  if (themeColor && color) themeColor.content = color;
}

export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  selectedTheme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
} {
  const [theme, setThemeState] = useState<ThemeChoice>(() => {
    const stored = readStored();
    if (stored) return stored;
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light";
  });

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const setTheme = useCallback((t: ThemeChoice) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((t) => (themeMode(t) === "dark" ? "light" : "dark")),
    [],
  );
  return { theme: themeMode(theme), selectedTheme: theme, toggle, setTheme };
}

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useThemeValue(): Theme {
  return useContext(ThemeContext);
}
