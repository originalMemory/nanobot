import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, RefreshCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deletePsbModel,
  fetchPsbModelDetail,
  rescanPsbModel,
  retryPsbTranslation,
  savePsbInitialState,
} from "@/lib/api";
import type {
  PsbInitialState,
  PsbModelDetail,
  PsbModelSummary,
  PsbSettingsUpdate,
  SettingsPayload,
} from "@/lib/types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  StatusPill,
  ToggleButton,
} from "./shared";

const EMPTY_INITIAL: PsbInitialState = {
  timeline: "",
  expression: "",
  face: {},
  fade: {},
};

function labelText(item: { label: string; labelZh?: string }): string {
  const zh = item.labelZh?.trim();
  if (zh && zh !== item.label) return `${item.label}（${zh}）`;
  return item.label;
}

function modelStatus(model: PsbModelSummary): { text: string; tone: "neutral" | "success" | "warning" } {
  if (!model.compatible) {
    return { text: model.parseError || "不兼容", tone: "warning" };
  }
  if (model.translationStatus === "failed") {
    return { text: "翻译失败", tone: "warning" };
  }
  if (model.translationStatus === "pending" || model.translationStatus === "translating") {
    return { text: "翻译中", tone: "neutral" };
  }
  return { text: "可用", tone: "success" };
}

interface PsbSectionProps {
  settings: SettingsPayload;
  token: string;
  apiBase: string;
  onSave: (update: PsbSettingsUpdate) => Promise<void>;
  onRefreshSettings: () => Promise<void>;
}

export function PsbSection({ settings, token, apiBase, onSave, onRefreshSettings }: PsbSectionProps) {
  const psb = settings.deskPet.psb;
  const [busy, setBusy] = useState(false);
  const [modelDetail, setModelDetail] = useState<PsbModelDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [initialDraft, setInitialDraft] = useState<PsbInitialState>(EMPTY_INITIAL);
  const [initialDirty, setInitialDirty] = useState(false);
  const [initialMessage, setInitialMessage] = useState<string | null>(null);

  const selectedId = psb.selectedModelId;

  const loadDetail = useCallback(async (modelId: string) => {
    setDetailLoading(true);
    try {
      const { model } = await fetchPsbModelDetail(token, modelId, apiBase);
      setModelDetail(model);
      setInitialDraft(model.initialState ?? EMPTY_INITIAL);
      setInitialDirty(false);
      setInitialMessage(null);
    } catch {
      setModelDetail(null);
      setInitialMessage("加载模型详情失败");
    } finally {
      setDetailLoading(false);
    }
  }, [apiBase, token]);

  useEffect(() => {
    if (!selectedId) {
      setModelDetail(null);
      setInitialDraft(EMPTY_INITIAL);
      setInitialDirty(false);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const loopingTimelines = useMemo(
    () => (modelDetail?.timelines ?? []).filter((item) => item.looping),
    [modelDetail],
  );

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  function openPsb() {
    if (!selectedId) return;
    if (window.electronAPI?.psb) {
      void window.electronAPI.psb.open({ url: apiBase, token, modelId: selectedId });
      return;
    }
    const url = new URL("/psb.html", apiBase);
    url.searchParams.set("token", token);
    url.searchParams.set("modelId", selectedId);
    window.open(url.toString(), "_blank", "width=540,height=540");
  }

  async function handleSelectModel(modelId: string) {
    await onSave({ selectedModelId: modelId || null });
  }

  async function handleDeleteModel(model: PsbModelSummary) {
    if (!window.confirm(`确定删除模型「${model.name}」？`)) return;
    await runAction(async () => {
      await deletePsbModel(token, model.modelId, apiBase);
      await onRefreshSettings();
      if (selectedId === model.modelId) {
        setModelDetail(null);
      }
    });
  }

  async function handleRescan(model: PsbModelSummary) {
    await runAction(async () => {
      const { model: refreshed } = await rescanPsbModel(token, model.modelId, apiBase);
      await onRefreshSettings();
      if (selectedId === model.modelId) {
        setModelDetail(refreshed);
        setInitialDraft(refreshed.initialState ?? EMPTY_INITIAL);
        setInitialDirty(false);
      }
    });
  }

  async function handleRetryTranslation(model: PsbModelSummary) {
    await runAction(async () => {
      const { model: refreshed } = await retryPsbTranslation(token, model.modelId, apiBase);
      await onRefreshSettings();
      if (selectedId === model.modelId) {
        setModelDetail(refreshed);
      }
    });
  }

  async function handleSaveInitialState() {
    if (!selectedId || !modelDetail) return;
    setBusy(true);
    setInitialMessage(null);
    try {
      const { model } = await savePsbInitialState(token, selectedId, initialDraft, apiBase);
      setModelDetail(model);
      setInitialDraft(model.initialState ?? EMPTY_INITIAL);
      setInitialDirty(false);
      setInitialMessage("已保存初始状态");
    } catch {
      setInitialMessage("保存失败：初始 timeline 须为循环项");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSectionTitle>PSB Desk Pet</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow
          title="模型目录"
          description="将 .psb / .emtbytes 放入 ~/.nanobot/desk_pets/psb/ 后重启 gateway 即可注册。"
        >
          <span className="max-w-[280px] text-right text-[12px] leading-5 text-muted-foreground">
            ~/.nanobot/desk_pets/psb/
          </span>
        </SettingsRow>
        <SettingsRow title="启动时自动展示" description="应用启动且已选可用模型时自动打开 PSB 窗口。">
          <ToggleButton
            checked={psb.autoShow}
            label={psb.autoShow ? "已启用" : "已关闭"}
            onChange={(autoShow) => void onSave({ autoShow })}
          />
        </SettingsRow>
        <SettingsRow title="鼠标追踪" description="全屏鼠标坐标驱动眼、头、身体变量。">
          <ToggleButton
            checked={psb.followMouse}
            label={psb.followMouse ? "已启用" : "已关闭"}
            onChange={(followMouse) => void onSave({ followMouse })}
          />
        </SettingsRow>
        <SettingsRow title="回复特殊标签" description="向 AI 注入 PSB 标签说明并解析 assistant 回复。">
          <ToggleButton
            checked={psb.enabledResponseTags}
            label={psb.enabledResponseTags ? "已启用" : "已关闭"}
            onChange={(enabledResponseTags) => void onSave({ enabledResponseTags })}
          />
        </SettingsRow>
        {psb.enabledResponseTags ? (
          <SettingsRow title="聊天中展示标签" description="关闭后 UI 隐藏标签，但仍会驱动桌宠。">
            <ToggleButton
              checked={psb.showResponseTags}
              label={psb.showResponseTags ? "展示" : "隐藏"}
              onChange={(showResponseTags) => void onSave({ showResponseTags })}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          title="当前模型"
          description="仅兼容模型可选为当前展示模型。"
        >
          <select
            className="h-8 max-w-[240px] rounded-full border border-input bg-background px-3 text-[13px]"
            value={selectedId ?? ""}
            onChange={(event) => void handleSelectModel(event.target.value)}
            disabled={busy}
          >
            <option value="">未选择</option>
            {psb.models.map((model) => (
              <option key={model.modelId} value={model.modelId} disabled={!model.compatible}>
                {model.name}
                {!model.compatible ? "（不可用）" : ""}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow title="PSB 桌宠窗口" description="打开或关闭当前 PSB 透明置顶窗口。">
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" className="gap-2" disabled={!selectedId} onClick={openPsb}>
              <ExternalLink className="h-4 w-4" aria-hidden />
              打开
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => void window.electronAPI?.psb?.close()}
            >
              <RefreshCcw className="h-4 w-4" aria-hidden />
              关闭
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsSectionTitle>模型列表</SettingsSectionTitle>
      <SettingsGroup>
        {psb.models.length === 0 ? (
          <SettingsRow title="暂无模型" description="将文件放入目录并重启 gateway 后刷新设置页。" />
        ) : (
          psb.models.map((model) => {
            const status = modelStatus(model);
            const selected = model.modelId === selectedId;
            return (
              <SettingsRow
                key={model.modelId}
                title={model.name}
                description={`${model.format.toUpperCase()} · ${model.modelId}${selected ? " · 当前选中" : ""}`}
              >
                <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
                  <StatusPill tone={status.tone}>{status.text}</StatusPill>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleRescan(model)}
                    >
                      重扫
                    </Button>
                    {model.translationStatus === "failed" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleRetryTranslation(model)}
                      >
                        重试翻译
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      disabled={busy}
                      onClick={() => void handleDeleteModel(model)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              </SettingsRow>
            );
          })
        )}
      </SettingsGroup>

      {selectedId ? (
        <>
          <SettingsSectionTitle>初始状态</SettingsSectionTitle>
          <SettingsGroup>
            {detailLoading ? (
              <SettingsRow title="加载中">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
              </SettingsRow>
            ) : modelDetail ? (
              <>
                <SettingsRow
                  title="初始 timeline"
                  description="只能选择循环 timeline；非循环项无法保存。"
                >
                  <select
                    className="h-8 max-w-[240px] rounded-full border border-input bg-background px-3 text-[13px]"
                    value={initialDraft.timeline}
                    onChange={(event) => {
                      setInitialDraft((prev) => ({ ...prev, timeline: event.target.value }));
                      setInitialDirty(true);
                    }}
                  >
                    <option value="">（无）</option>
                    {loopingTimelines.map((item) => (
                      <option key={item.label} value={item.label}>
                        {labelText(item)}
                      </option>
                    ))}
                  </select>
                </SettingsRow>
                <SettingsRow title="初始表情">
                  <select
                    className="h-8 max-w-[240px] rounded-full border border-input bg-background px-3 text-[13px]"
                    value={initialDraft.expression}
                    onChange={(event) => {
                      setInitialDraft((prev) => ({ ...prev, expression: event.target.value }));
                      setInitialDirty(true);
                    }}
                  >
                    <option value="">（无）</option>
                    {(modelDetail.expressions ?? []).map((item) => (
                      <option key={item.label} value={item.label}>
                        {labelText(item)}
                      </option>
                    ))}
                  </select>
                </SettingsRow>
                {(modelDetail.faceVariables ?? []).slice(0, 6).map((variable) => (
                  <SettingsRow key={variable.label} title={`Face · ${labelText(variable)}`}>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      className="w-28"
                      value={initialDraft.face[variable.label] ?? ""}
                      onChange={(event) => {
                        const raw = event.target.value;
                        setInitialDraft((prev) => {
                          const face = { ...prev.face };
                          if (raw === "") {
                            delete face[variable.label];
                          } else {
                            face[variable.label] = Number(raw);
                          }
                          return { ...prev, face };
                        });
                        setInitialDirty(true);
                      }}
                    />
                  </SettingsRow>
                ))}
                {(modelDetail.fadeVariables ?? []).slice(0, 6).map((variable) => (
                  <SettingsRow key={variable.label} title={`Fade · ${labelText(variable)}`}>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      className="w-28"
                      value={initialDraft.fade[variable.label] ?? ""}
                      onChange={(event) => {
                        const raw = event.target.value;
                        setInitialDraft((prev) => {
                          const fade = { ...prev.fade };
                          if (raw === "") {
                            delete fade[variable.label];
                          } else {
                            fade[variable.label] = Number(raw);
                          }
                          return { ...prev, fade };
                        });
                        setInitialDirty(true);
                      }}
                    />
                  </SettingsRow>
                ))}
                <div className="flex min-h-[58px] items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <span className="text-[13px] text-muted-foreground">
                    {initialMessage ?? (initialDirty ? "有未保存的初始状态更改" : "")}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="rounded-full"
                    disabled={!initialDirty || busy}
                    onClick={() => void handleSaveInitialState()}
                  >
                    保存初始状态
                  </Button>
                </div>
              </>
            ) : (
              <SettingsRow title="无法加载模型详情" description={initialMessage ?? undefined} />
            )}
          </SettingsGroup>
        </>
      ) : null}
    </>
  );
}
