import { useEffect, useState } from "react";
import { ExternalLink, RefreshCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deletePsbModel, rescanPsbModel, retryPsbTranslation } from "@/lib/api";
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

function modelStatus(model: PsbModelSummary): { text: string; tone: "neutral" | "success" | "warning" } {
  if (!model.compatible) {
    return { text: model.parseError || "不兼容", tone: "warning" };
  }
  if (model.translationStatus === "failed") {
    return { text: "翻译失败", tone: "warning" };
  }
  if (model.translationStatus === "pending") {
    return { text: "待翻译", tone: "neutral" };
  }
  if (model.translationStatus === "translating") {
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
  const [translationMessage, setTranslationMessage] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [windowWidth, setWindowWidth] = useState(DEFAULT_PSB_WINDOW_SIZE);
  const [windowHeight, setWindowHeight] = useState(DEFAULT_PSB_WINDOW_SIZE);

  const selectedId = psb.selectedModelId;

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
    if (!window.confirm(`确定删除模型「${model.name}」？`)) return;
    await runAction(async () => {
      await deletePsbModel(token, model.modelId, apiBase);
      await onRefreshSettings();
    });
  }

  async function handleRescan(model: PsbModelSummary) {
    await runAction(async () => {
      await rescanPsbModel(token, model.modelId, apiBase);
      await onRefreshSettings();
    });
  }

  async function handleRetryTranslation(model: PsbModelSummary) {
    setTranslationMessage(null);
    setBusy(true);
    try {
      const { model: refreshed } = await retryPsbTranslation(token, model.modelId, apiBase);
      await onRefreshSettings();
      if (refreshed.translationStatus === "done") {
        setTranslationMessage({ text: `「${model.name}」翻译已完成` });
        return;
      }
      if (refreshed.translationStatus === "failed") {
        setTranslationMessage({
          text: `「${model.name}」翻译失败：LLM 未返回有效结果，请检查 gateway 的模型配置与网络后重试`,
          error: true,
        });
        return;
      }
      setTranslationMessage({
        text: `「${model.name}」仍有未翻译标签，请稍后重试`,
        error: true,
      });
    } catch {
      setTranslationMessage({
        text: `「${model.name}」翻译请求失败，请确认 gateway 正在运行`,
        error: true,
      });
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
        <SettingsRow
          title="PSB 桌宠窗口"
          description="打开后点齿轮进入配置面板，可设置 timeline、表情、Face/Fade 并保存初始状态。"
        >
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

      <SettingsSectionTitle>窗口</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow title="窗口宽度" description="保存在本机；新建或再次打开 PSB 窗口时使用。">
          <Input
            type="number"
            min={PSB_WINDOW_SIZE_MIN}
            max={PSB_WINDOW_SIZE_MAX}
            value={windowWidth}
            onChange={(event) => void saveWindowSize({ width: Number(event.target.value) })}
            className="w-28"
          />
        </SettingsRow>
        <SettingsRow title="窗口高度" description="也可在 PSB 窗口边缘拖拽调整，会自动记住。">
          <Input
            type="number"
            min={PSB_WINDOW_SIZE_MIN}
            max={PSB_WINDOW_SIZE_MAX}
            value={windowHeight}
            onChange={(event) => void saveWindowSize({ height: Number(event.target.value) })}
            className="w-28"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsSectionTitle>模型列表</SettingsSectionTitle>
      {translationMessage ? (
        <p
          className={
            translationMessage.error
              ? "mb-2 text-[12px] leading-5 text-destructive"
              : "mb-2 text-[12px] leading-5 text-muted-foreground"
          }
        >
          {translationMessage.text}
        </p>
      ) : null}
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
                    {model.translationStatus === "pending" || model.translationStatus === "failed" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleRetryTranslation(model)}
                      >
                        {model.translationStatus === "failed" ? "重试翻译" : "翻译"}
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
    </>
  );
}
