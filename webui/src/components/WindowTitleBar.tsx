import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getRuntimeHost } from "@/lib/runtime";

/** 沿用 lover 的 30px 无边框顶栏，macOS 保留原生红绿灯。 */
export function DesktopWindowFrame({ children }: { children: ReactNode }) {
  const controls = getRuntimeHost().windowControls;
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!controls) return;
    let active = true;
    void controls.read().then((value) => { if (active) setMaximized(value); });
    const unsubscribe = controls.onState(setMaximized);
    return () => { active = false; unsubscribe(); };
  }, [controls]);
  if (!controls) return children;

  const actions = [
    { action: "minimize", label: t("app.window.minimize"), icon: <Minus className="h-3.5 w-3.5" strokeWidth={1.75} /> },
    { action: "maximize", label: t(maximized ? "app.window.restore" : "app.window.maximize"), icon: maximized ? <Copy className="h-3 w-3" strokeWidth={1.75} /> : <Square className="h-3 w-3" strokeWidth={1.75} /> },
    { action: "close", label: t("app.window.close"), icon: <X className="h-3.5 w-3.5" strokeWidth={1.75} /> },
  ] as const;
  return <div className="flex h-full w-full flex-col overflow-hidden bg-background">
    <header data-testid="desktop-titlebar" className={`desktop-titlebar relative z-40 flex h-[30px] shrink-0 select-none items-center border-b border-sidebar-border/60 bg-sidebar ${controls.isMac ? "pl-[78px]" : "pl-3"}`}
      style={{ WebkitAppRegion: "drag" } as CSSProperties}>
      <div className="min-w-0 flex-1" />
      {!controls.isMac && <div className="flex h-full items-stretch" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
        {actions.map(({ action, label, icon }) => <button key={action} type="button" title={label} aria-label={label}
          onMouseDown={(event) => event.preventDefault()} onClick={() => void controls.action(action)}
          className={`inline-flex w-11 items-center justify-center text-muted-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${action === "close" ? "hover:bg-destructive hover:text-destructive-foreground" : "hover:bg-muted hover:text-foreground"}`}>
          {icon}
        </button>)}
      </div>}
    </header>
    <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>;
}
