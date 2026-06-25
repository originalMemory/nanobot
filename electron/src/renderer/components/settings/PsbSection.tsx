import { useEffect, useState } from "react";
import { ExternalLink, RefreshCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deletePsbModel } from "@/lib/api";
import type { PsbModelSummary, PsbSettingsUpdate, SettingsPayload } from "@/lib/types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  StatusPill,
  ToggleButton,
} from "./shared";

const PSB_WINDOW_SIZE_MIN = 240;
const PSB_WINDOW_SIZE_MAX = 2400;
const DEFAULT_PSB_WINDOW_SIZE = 350;

function clampPsbWindowSize(value: number): number {
  return Math.max(PSB_WINDOW_SIZE_MIN, Math.min(PSB_WINDOW_SIZE_MAX, Math.floor(value)));
}

type TranslateFn = (key: string, options?: { defaultValue?: string; name?: string }) => string;

function modelStatus(
  model: PsbModelSummary,
  t: TranslateFn,
): { text: string; tone: "neutral" | "success" | "warning" } {
  if (!model.compatible) {
    return {
      text: model.parseError || t("settings.deskPet.psb.status.incompatible", { defaultValue: "Incompatible" }),
      tone: "warning",
    };
  }
  if (model.translationStatus === "failed") {
    return {
      text: t("settings.deskPet.psb.status.translateFailed", { defaultValue: "Translation failed" }),
      tone: "warning",
    };
  }
  if (model.translationStatus === "pending") {
    return {
      text: t("settings.deskPet.psb.status.pendingTranslate", { defaultValue: "Pending translation" }),
      tone: "neutral",
    };
  }
  if (model.translationStatus === "translating") {
    return {
      text: t("settings.deskPet.psb.status.translating", { defaultValue: "Translating" }),
      tone: "neutral",
    };
  }
  return {
    text: t("settings.deskPet.psb.status.available", { defaultValue: "Available" }),
    tone: "success",
  };
}

interface PsbSectionProps {
  settings: SettingsPayload;
  token: string;
  apiBase: string;
  onSave: (update: PsbSettingsUpdate) => Promise<void>;
  onRefreshSettings: () => Promise<void>;
}

export function PsbSection({ settings, token, apiBase, onSave, onRefreshSettings }: PsbSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const psb = settings.deskPet.psb;
  const [busy, setBusy] = useState(false);
  const [windowWidth, setWindowWidth] = useState(DEFAULT_PSB_WINDOW_SIZE);
  const [windowHeight, setWindowHeight] = useState(DEFAULT_PSB_WINDOW_SIZE);

  const selectedId = psb.selectedModelId;
  const selectedModel = psb.models.find((model) => model.modelId === selectedId) ?? null;
  const selectedStatus = selectedModel ? modelStatus(selectedModel, t) : null;
  const toggleLabel = (checked: boolean) =>
    checked ? tx("settings.values.enabled", "Enabled") : tx("settings.deskPet.common.toggleOff", "Off");

  useEffect(() => {
    const api = window.electronAPI?.psb;
    if (!api?.getWindowState) return;
    void api.getWindowState().then((state) => {
      if (typeof state.width === "number") {
        setWindowWidth(state.width);
      }
      if (typeof state.height === "number") {
        setWindowHeight(state.height);
      }
    });
  }, []);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function saveWindowSize(patch: { width?: number; height?: number }) {
    const width = clampPsbWindowSize(patch.width ?? windowWidth);
    const height = clampPsbWindowSize(patch.height ?? windowHeight);
    setWindowWidth(width);
    setWindowHeight(height);
    await window.electronAPI?.psb?.saveWindowState({ width, height });
  }

  function openPsb() {
    if (!selectedId) return;
    if (window.electronAPI?.psb) {
      void window.electronAPI.psb.open({
        url: apiBase,
        token,
        modelId: selectedId,
        width: windowWidth,
        height: windowHeight,
      });
      return;
    }
    const url = new URL("/psb.html", apiBase);
    url.searchParams.set("token", token);
    url.searchParams.set("modelId", selectedId);
    window.open(url.toString(), "_blank", `width=${windowWidth},height=${windowHeight}`);
  }

  async function handleSelectModel(modelId: string) {
    await onSave({ selectedModelId: modelId || null });
  }

  async function handleDeleteModel(model: PsbModelSummary) {
    const confirmMessage = t("settings.deskPet.psb.deleteConfirm", {
      name: model.name,
      defaultValue: `Delete model "${model.name}"?`,
    });
    if (!window.confirm(confirmMessage)) return;
    await runAction(async () => {
      await deletePsbModel(token, model.modelId, apiBase);
      await onRefreshSettings();
    });
  }

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{tx("settings.deskPet.psb.modelsSection", "Models")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.deskPet.psb.modelDirectory", "Model directory")}
            description={tx(
              "settings.deskPet.psb.modelDirectoryDescription",
              "Place .psb / .emtbytes files in ~/.nanobot/desk_pets/psb/ and restart the gateway to register them. Delete the sidecar .meta.json and reopen the desk pet to force a full runtime metadata upload.",
            )}
          >
            <span className="max-w-[280px] text-right text-[12px] leading-5 text-muted-foreground">
              ~/.nanobot/desk_pets/psb/
            </span>
          </SettingsRow>
          {psb.models.length === 0 ? (
            <SettingsRow
              title={tx("settings.deskPet.psb.noModels", "No models")}
              description={tx(
                "settings.deskPet.psb.noModelsDescription",
                "Add files to the directory and refresh settings after restarting the gateway.",
              )}
            />
          ) : (
            <SettingsRow
              title={tx("settings.deskPet.psb.currentModel", "Current model")}
              description={
                selectedModel
                  ? `${selectedModel.format.toUpperCase()} · ${selectedModel.modelId}`
                  : tx(
                      "settings.deskPet.psb.currentModelDescription",
                      "Only compatible models can be selected for display.",
                    )
              }
            >
              <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
                <select
                  className="h-8 max-w-[200px] rounded-full border border-input bg-background px-3 text-[13px]"
                  value={selectedId ?? ""}
                  onChange={(event) => void handleSelectModel(event.target.value)}
                  disabled={busy}
                >
                  <option value="">{tx("settings.deskPet.psb.noSelection", "Not selected")}</option>
                  {psb.models.map((model) => (
                    <option key={model.modelId} value={model.modelId} disabled={!model.compatible}>
                      {model.name}
                      {!model.compatible
                        ? tx("settings.deskPet.psb.unavailableSuffix", " (unavailable)")
                        : ""}
                    </option>
                  ))}
                </select>
                {selectedModel ? (
                  <>
                    <StatusPill tone={selectedStatus.tone}>{selectedStatus.text}</StatusPill>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        disabled={busy}
                        onClick={() => void handleDeleteModel(selectedModel)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            </SettingsRow>
          )}
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>
          {tx("settings.deskPet.psb.behaviorSection", "Behavior & window")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.deskPet.psb.autoShow", "Show on startup")}
            description={tx(
              "settings.deskPet.psb.autoShowDescription",
              "Automatically open the PSB window when the app starts if a compatible model is selected.",
            )}
          >
            <ToggleButton
              checked={psb.autoShow}
              label={toggleLabel(psb.autoShow)}
              onChange={(autoShow) => void onSave({ autoShow })}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.deskPet.psb.followMouse", "Mouse tracking")}
            description={tx(
              "settings.deskPet.psb.followMouseDescription",
              "Full-screen mouse coordinates drive eye, head, and body variables.",
            )}
          >
            <ToggleButton
              checked={psb.followMouse}
              label={toggleLabel(psb.followMouse)}
              onChange={(followMouse) => void onSave({ followMouse })}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.deskPet.psb.responseTags", "Reply special tags")}
            description={tx(
              "settings.deskPet.psb.responseTagsDescription",
              "Inject PSB tag instructions into AI prompts and parse assistant replies.",
            )}
          >
            <ToggleButton
              checked={psb.enabledResponseTags}
              label={toggleLabel(psb.enabledResponseTags)}
              onChange={(enabledResponseTags) => void onSave({ enabledResponseTags })}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.deskPet.psb.windowSize", "Window size")}
            description={tx(
              "settings.deskPet.psb.windowSizeDescription",
              "Stored locally. Open the window to adjust timeline, expressions, Face/Fade in the config panel; drag edges to resize.",
            )}
          >
            <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={PSB_WINDOW_SIZE_MIN}
                  max={PSB_WINDOW_SIZE_MAX}
                  value={windowWidth}
                  onChange={(event) => void saveWindowSize({ width: Number(event.target.value) })}
                  className="w-24"
                  aria-label={tx("settings.deskPet.psb.windowSize", "Window size")}
                />
                <span className="text-xs text-muted-foreground">×</span>
                <Input
                  type="number"
                  min={PSB_WINDOW_SIZE_MIN}
                  max={PSB_WINDOW_SIZE_MAX}
                  value={windowHeight}
                  onChange={(event) => void saveWindowSize({ height: Number(event.target.value) })}
                  className="w-24"
                  aria-label={tx("settings.deskPet.psb.windowSize", "Window size")}
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" size="sm" className="gap-2" disabled={!selectedId} onClick={openPsb}>
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  {tx("settings.deskPet.common.open", "Open")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={() => void window.electronAPI?.psb?.close()}
                >
                  <RefreshCcw className="h-4 w-4" aria-hidden />
                  {tx("settings.deskPet.common.close", "Close")}
                </Button>
              </div>
            </div>
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
