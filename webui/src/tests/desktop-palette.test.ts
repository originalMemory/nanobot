import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const css = readFileSync(resolve(process.cwd(), "src/globals.css"), "utf8");
import { expect, it } from "vitest";
import { THEME_CHOICES } from "@/hooks/useTheme";

function declarations(selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return Object.fromEntries([...css.slice(start, css.indexOf("}", start)).matchAll(/--([\w-]+):\s*([^;]+);/g)]
    .map((match) => [match[1], match[2]]));
}
function luminance(hsl: string) {
  const [h, s, l] = hsl.replaceAll("%", "").split(/\s+/).map(Number);
  const a = s / 100 * Math.min(l / 100, 1 - l / 100);
  const rgb = [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

it.each(THEME_CHOICES)("%s supplies current UI surfaces and readable foreground/background pairs", (theme) => {
  const colors = { ...declarations("html.native-host[data-theme]"),
    ...declarations(`html.native-host[data-theme="${theme}"]`) };
  const resolve = (key: string): string => {
    expect(colors[key], key).toBeDefined();
    const alias = colors[key].match(/^var\(--([\w-]+)\)$/);
    return alias ? resolve(alias[1]) : colors[key];
  };
  expect(colors).not.toHaveProperty("radius");
  const pairs = [
    ["foreground", "background"], ["card-foreground", "card"], ["popover-foreground", "popover"],
    ["primary-foreground", "primary"], ["primary", "background"],
    ["secondary-foreground", "secondary"], ["muted-foreground", "muted"],
    ["accent-foreground", "accent"], ["destructive-foreground", "destructive"],
    ["sidebar-content", "sidebar"], ["sidebar-muted-foreground", "sidebar"],
    ["sidebar-accent-foreground", "sidebar-selected"],
    ["foreground", "settings-canvas"], ["muted-foreground", "settings-surface"],
  ];
  for (const [fg, bg] of pairs) {
    const [low, high] = [luminance(resolve(fg)), luminance(resolve(bg))].sort((a, b) => a - b);
    expect((high + 0.05) / (low + 0.05), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
});

it.each(THEME_CHOICES)("preboot restores %s before React mounts", (theme) => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).find((value) => value.includes("nanobot-webui.theme"));
  expect(script).toBeDefined();
  const classes = new Set<string>();
  const root = { dataset: {} as Record<string, string>, classList: { add: (name: string) => classes.add(name) } };
  runInNewContext(script!, {
    localStorage: { getItem: () => theme }, location: { protocol: "nanobot:", host: "desktop" },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: root, querySelector: () => null },
  });
  expect(root.dataset.theme).toBe(theme);
  expect(classes.has("native-host")).toBe(true);
  expect(classes.has("dark")).toBe(["dark", "midnight", "neon"].includes(theme));
});
