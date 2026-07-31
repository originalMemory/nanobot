import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiError, fetchAutomations, runAutomationAction } from "@/lib/api";
import type { AutomationItem } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AutomationViewProps {
  token: string;
  gatewayUrl: string;
  onBack: () => void;
}

export function formatAutomationInterval(milliseconds: number): string {
  if (milliseconds % 86_400_000 === 0) return `${milliseconds / 86_400_000}d`;
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
}

export function AutomationView({ token, gatewayUrl, onBack }: AutomationViewProps) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<AutomationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationItem | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const payload = await fetchAutomations(token, gatewayUrl);
      setItems(payload.automations);
    } catch (err) {
      if (!silent) {
        setError(
          err instanceof ApiError
            ? t("automations.errors.http", { status: err.status })
            : t("automations.errors.load"),
        );
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [gatewayUrl, t, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!items.some((item) => item.running)) return;
    const timer = window.setTimeout(() => {
      void load(true);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [items, load]);

  const act = useCallback(async (
    item: AutomationItem,
    action: "enable" | "disable" | "run" | "delete",
  ) => {
    setPending(`${action}:${item.id}`);
    setError(null);
    try {
      const payload = await runAutomationAction(token, action, item.id, gatewayUrl);
      setItems(payload.automations);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? t("automations.errors.http", { status: err.status })
          : t("automations.errors.action"),
      );
    } finally {
      setPending(null);
    }
  }, [gatewayUrl, t, token]);

  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const formatTime = (value: number | null) => (
    value ? dateFormatter.format(new Date(value)) : t("automations.never")
  );
  const formatSchedule = (item: AutomationItem) => {
    if (item.schedule.kind === "at") {
      return item.schedule.at_ms
        ? t("automations.schedule.at", { time: formatTime(item.schedule.at_ms) })
        : t("automations.schedule.invalid");
    }
    if (item.schedule.kind === "every") {
      return item.schedule.every_ms
        ? t("automations.schedule.every", {
            interval: formatAutomationInterval(item.schedule.every_ms),
          })
        : t("automations.schedule.invalid");
    }
    return [
      item.schedule.expr ?? t("automations.schedule.invalid"),
      item.schedule.tz,
    ].filter(Boolean).join(" · ");
  };
  const formatSource = (item: AutomationItem) => {
    if (item.protected) return t("automations.deliveryTarget.system");
    if (item.source.channel) {
      return item.source.to
        ? `${item.source.channel}:${item.source.to}`
        : item.source.channel;
    }
    if (item.source.session_key) return item.source.session_key;
    return t("automations.deliveryTarget.internal");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border/60 bg-background/35 px-4 py-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t("automations.back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">{t("automations.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("automations.subtitle")}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          disabled={loading || pending !== null}
          aria-label={t("automations.refresh")}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </header>

      <div className="scroll-surface min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <LoaderCircle className="h-5 w-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <CalendarClock className="h-8 w-8 opacity-60" />
            <p className="text-sm">{t("automations.empty.title")}</p>
            <p className="max-w-sm text-xs">{t("automations.empty.description")}</p>
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-4xl gap-3">
            {items.map((item) => {
              const busy = pending !== null || item.running;
              return (
                <article
                  key={item.id}
                  className="rounded-xl border border-border/55 bg-background/55 p-4 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                      <div className={cn(
                        "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
                        item.running
                          ? "animate-pulse bg-amber-400"
                          : item.enabled
                            ? "bg-emerald-400"
                            : "bg-muted-foreground/35",
                      )} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-sm font-semibold">{item.name}</h2>
                        {item.protected ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] text-primary">
                            <ShieldCheck className="h-3 w-3" />
                            {t("automations.system")}
                          </span>
                        ) : null}
                        <span className="text-[11px] text-muted-foreground">
                          {item.running
                            ? t("automations.running")
                            : item.enabled
                              ? t("automations.enabled")
                              : t("automations.paused")}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-xs text-foreground/75">
                        {formatSchedule(item)}
                      </p>
                      <dl className="mt-3 grid gap-x-5 gap-y-1 text-xs sm:grid-cols-3">
                        <AutomationMeta
                          label={t("automations.nextRun")}
                          value={formatTime(item.state.next_run_at_ms)}
                        />
                        <AutomationMeta
                          label={t("automations.lastRun")}
                          value={formatTime(item.state.last_run_at_ms)}
                          tone={item.state.last_status === "error" ? "error" : undefined}
                        />
                        <AutomationMeta
                          label={t("automations.deliveryTarget.label")}
                          value={formatSource(item)}
                        />
                      </dl>
                      {item.state.last_error ? (
                        <p className="mt-2 truncate text-xs text-destructive" title={item.state.last_error}>
                          {item.state.last_error}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || item.protected}
                        onClick={() => void act(item, item.enabled ? "disable" : "enable")}
                        aria-label={item.enabled ? t("automations.actions.pause") : t("automations.actions.resume")}
                        title={item.protected ? t("automations.protectedHint") : undefined}
                      >
                        {item.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || item.protected}
                        onClick={() => void act(item, "run")}
                        aria-label={t("automations.actions.run")}
                        title={item.protected ? t("automations.protectedHint") : undefined}
                      >
                        {item.running || pending === `run:${item.id}`
                          ? <LoaderCircle className="h-4 w-4 animate-spin" />
                          : <RefreshCw className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || item.protected}
                        onClick={() => setDeleteTarget(item)}
                        aria-label={t("automations.actions.delete")}
                        title={item.protected ? t("automations.protectedHint") : undefined}
                        className="hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("automations.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("automations.delete.description", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("automations.delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void act(deleteTarget, "delete");
                setDeleteTarget(null);
              }}
            >
              {t("automations.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AutomationMeta({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "error";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-foreground/80", tone === "error" && "text-destructive")}>
        {value}
      </dd>
    </div>
  );
}
