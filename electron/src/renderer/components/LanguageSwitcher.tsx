import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  supportedLocales,
  type SupportedLocale,
} from "@/i18n/config";
import { setAppLanguage } from "@/i18n";
import { isElectron } from "@/lib/env";

const ELECTRON_STORE_KEY = "appearance.language";

async function persistLanguageToStore(locale: SupportedLocale): Promise<void> {
  if (!isElectron) return;
  try {
    await window.electronAPI.config.set(ELECTRON_STORE_KEY, locale);
  } catch {
    // ignore
  }
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const currentLocale = i18n.resolvedLanguage ?? i18n.language ?? "en";

  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    window.electronAPI.config.get(ELECTRON_STORE_KEY).then((stored) => {
      if (!cancelled && typeof stored === "string" && stored) {
        void setAppLanguage(stored as SupportedLocale);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current =
    supportedLocales.find((l) => l.code === currentLocale) ?? supportedLocales[0];

  const handleSelect = async (locale: SupportedLocale) => {
    await setAppLanguage(locale);
    await persistLanguageToStore(locale);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 w-[160px] justify-between rounded-full border-input bg-background px-3 text-[13px] font-normal shadow-none",
            "hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <span className="truncate">{current.nativeLabel}</span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[180px] rounded-[18px] border-border/65 bg-popover p-1.5 text-popover-foreground shadow-[0_18px_55px_rgba(15,23,42,0.18)] dark:border-white/10 dark:shadow-[0_22px_55px_rgba(0,0,0,0.45)]"
      >
        {supportedLocales.map((locale) => {
          const selected = locale.code === currentLocale;
          return (
            <DropdownMenuItem
              key={locale.code}
              onSelect={() => void handleSelect(locale.code)}
              className={cn(
                "flex cursor-default items-center justify-between rounded-[12px] px-2.5 py-2 text-[13px]",
                "focus:bg-muted/85 focus:text-foreground",
                selected && "bg-muted/80 text-foreground focus:bg-muted",
              )}
            >
              <span className="flex flex-col">
                <span className="font-medium">{locale.nativeLabel}</span>
                <span className="text-[11px] text-muted-foreground">{locale.label}</span>
              </span>
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
