import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { isElectron } from "@/lib/env";

const dragStyle = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** 无边框窗口顶栏：macOS 保留原生红绿灯区域，Windows/Linux 自绘窗口按钮 */
export function WindowTitleBar() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  const isMac = isElectron && window.electronAPI.platform.isMac;

  useEffect(() => {
    if (!isElectron) return;
    return window.electronAPI.window.onStateChange((state) => {
      setMaximized(state === "maximized");
    });
  }, []);

  if (!isElectron) return null;

  const runAction = (action: "minimize" | "maximize" | "close") => {
    void window.electronAPI.window.action(action);
  };

  return (
    <header
      className={cn(
        "flex h-[30px] shrink-0 select-none items-center border-b border-sidebar-border/60 bg-sidebar",
        isMac ? "pl-[78px]" : "pl-3",
      )}
      style={dragStyle}
    >
      <div className="min-w-0 flex-1" />

      {!isMac && (
        <div className="flex h-full items-stretch" style={noDragStyle}>
          <TitleBarButton
            label={t("app.window.minimize")}
            onClick={() => runAction("minimize")}
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </TitleBarButton>
          <TitleBarButton
            label={maximized ? t("app.window.restore") : t("app.window.maximize")}
            onClick={() => runAction("maximize")}
          >
            {maximized ? (
              <Copy className="h-3 w-3" strokeWidth={1.75} />
            ) : (
              <Square className="h-3 w-3" strokeWidth={1.75} />
            )}
          </TitleBarButton>
          <TitleBarButton
            label={t("app.window.close")}
            onClick={() => runAction("close")}
            variant="close"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </TitleBarButton>
        </div>
      )}
    </header>
  );
}

function TitleBarButton({
  label,
  onClick,
  children,
  variant = "default",
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  variant?: "default" | "close";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // 阻止鼠标点击抢焦点，避免出现 Windows 默认橙色 focus 边框
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex w-11 items-center justify-center text-muted-foreground transition-colors outline-none focus:outline-none focus-visible:outline-none",
        variant === "close"
          ? "hover:bg-destructive hover:text-destructive-foreground"
          : "hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
