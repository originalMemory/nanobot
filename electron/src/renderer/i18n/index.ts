import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import {
  applyDocumentLocale,
  defaultLocale,
  detectNavigatorLocale,
  fallbackLocale,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  persistLocale,
  readStoredLocale,
  resolveInitialLocale,
  type SupportedLocale,
} from "./config";

import enCommon from "./locales/en/common.json";
import zhCNCommon from "./locales/zh-CN/common.json";

export const resources = {
  en: { common: enCommon },
  "zh-CN": { common: zhCNCommon },
} as const;

export function currentLocale(): SupportedLocale {
  return normalizeLocale(i18n.resolvedLanguage ?? i18n.language ?? defaultLocale);
}

export async function setAppLanguage(locale: SupportedLocale): Promise<void> {
  await i18n.changeLanguage(locale);
}

const ELECTRON_LANGUAGE_KEY = "appearance.language";

/** 将语言偏好写入 Electron 本地 store（仅 Electron 环境） */
export async function persistLanguageToElectronStore(
  locale: SupportedLocale,
): Promise<void> {
  if (typeof window === "undefined" || !window.electronAPI) return;
  try {
    await window.electronAPI.config.set(ELECTRON_LANGUAGE_KEY, locale);
  } catch {
    // ignore
  }
}

/**
 * Electron 启动时统一语言来源，避免 appearance 页 LanguageSwitcher mount
 * 时用 store 默认值 en 覆盖 localStorage / 系统语言的 zh-CN。
 */
export async function bootstrapAppLanguage(): Promise<void> {
  if (typeof window === "undefined" || !window.electronAPI) return;

  let stored: unknown;
  try {
    stored = await window.electronAPI.config.get(ELECTRON_LANGUAGE_KEY);
  } catch {
    return;
  }

  const fromLocal = readStoredLocale();
  const detected = detectNavigatorLocale();
  const storedText = typeof stored === "string" ? stored.trim() : "";

  if (storedText) {
    const normalizedStored = normalizeLocale(storedText);
    // 迁移：store 里仍是默认 en，但 localStorage 已检测到中文等非 en 环境
    if (normalizedStored === "en" && fromLocal && fromLocal !== "en") {
      await setAppLanguage(fromLocal);
      await persistLanguageToElectronStore(fromLocal);
      return;
    }
    if (normalizedStored !== currentLocale()) {
      await setAppLanguage(normalizedStored);
    }
    return;
  }

  const locale = fromLocal ?? detected;
  if (locale !== currentLocale()) {
    await setAppLanguage(locale);
  }
  await persistLanguageToElectronStore(locale);
}

if (!i18n.isInitialized) {
  void i18n
    .use(initReactI18next)
    .init({
      resources,
      lng: resolveInitialLocale(),
      fallbackLng: fallbackLocale,
      defaultNS: "common",
      ns: ["common"],
      interpolation: {
        escapeValue: false,
      },
      returnNull: false,
      supportedLngs: Object.keys(resources),
    });
}

const syncLocaleSideEffects = (language: string) => {
  const locale = normalizeLocale(language);
  applyDocumentLocale(locale);
  persistLocale(locale);
};

syncLocaleSideEffects(currentLocale());
i18n.on("languageChanged", syncLocaleSideEffects);

export { LOCALE_STORAGE_KEY };
export default i18n;
