import { Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface RestartBannerProps {
  visible: boolean;
  onRestart: () => void;
  isRestarting?: boolean;
}

export function RestartBanner({ visible, onRestart, isRestarting = false }: RestartBannerProps) {
  const { t } = useTranslation();

  if (!visible) return null;

  return (
    <div className="flex items-center justify-between rounded-[18px] border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-[13px] dark:border-amber-400/20 dark:bg-amber-400/6">
      <span className="font-medium text-amber-700 dark:text-amber-300">
        {t("settings.status.savedRestartApply", {
          defaultValue: "Restart required for changes to take effect.",
        })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={onRestart}
        disabled={isRestarting}
        className="ml-4 rounded-full text-amber-700 hover:bg-amber-500/12 hover:text-amber-800 dark:text-amber-300 dark:hover:bg-amber-400/10"
      >
        {isRestarting ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        )}
        {isRestarting ? t("app.system.restarting") : t("app.system.restart")}
      </Button>
    </div>
  );
}
