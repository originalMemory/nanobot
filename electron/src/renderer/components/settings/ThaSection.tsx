import { useState } from "react";
import { ExternalLink, RefreshCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SettingsPayload, ThaSettingsUpdate } from "@/lib/types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  ToggleButton,
} from "./shared";

interface ThaSectionProps {
  settings: SettingsPayload;
  token: string;
  apiBase: string;
  onSave: (update: ThaSettingsUpdate) => Promise<void>;
}

export function ThaSection({ settings, token, apiBase, onSave }: ThaSectionProps) {
  const config = settings.deskPet.tha.config;
  const model = settings.deskPet.tha.model;
  const [, setSaving] = useState(false);

  async function save(update: ThaSettingsUpdate) {
    setSaving(true);
    try {
      await onSave(update);
    } finally {
      setSaving(false);
    }
  }

  function openTha() {
    const width = config.windowWidth;
    const height = config.windowHeight;
    if (window.electronAPI?.tha) {
      void window.electronAPI.tha.open({ url: apiBase, token, width, height });
      return;
    }
    const url = new URL("/tha.html", apiBase);
    url.searchParams.set("token", token);
    window.open(url.toString(), "_blank", `width=${width},height=${height}`);
  }

  return (
    <>
      <SettingsSectionTitle>THA Desk Pet</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow
          title="启动 THA"
          description="打开独立 2D 桌面宠物页面；Electron 中会创建透明置顶窗口。"
        >
          <Button type="button" size="sm" onClick={openTha} className="gap-2">
            <ExternalLink className="h-4 w-4" aria-hidden />
            打开
          </Button>
        </SettingsRow>
        <SettingsRow title="表情标签" description="允许模型输出 <happy> / <nod> 等标签驱动 THA。">
          <ToggleButton
            checked={config.enabledEmotions}
            label={config.enabledEmotions ? "已启用" : "已关闭"}
            onChange={(enabledEmotions) => save({ enabledEmotions })}
          />
        </SettingsRow>
        <SettingsRow title="口型同步" description="THA 页面播放音频并分析音量后驱动 mouth。">
          <ToggleButton
            checked={config.enabledMouthSync}
            label={config.enabledMouthSync ? "已启用" : "已关闭"}
            onChange={(enabledMouthSync) => save({ enabledMouthSync })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsSectionTitle>模型</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow
          title={model.available ? "模型已就绪" : "未找到模型"}
          description="固定读取 tha_model/model.mlpackage 或 tha_model/model.onnx；更换模型时直接替换该文件。"
        >
          <span className="block max-w-[360px] truncate text-right text-[13px] text-muted-foreground">
            {model.available ? `${model.format} · ${model.path}` : model.path}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsSectionTitle>窗口与延迟</SettingsSectionTitle>
      <SettingsGroup>
        <SettingsRow title="窗口宽度">
          <Input
            type="number"
            min={240}
            max={2400}
            value={config.windowWidth}
            onChange={(event) => save({ windowWidth: Number(event.target.value) })}
            className="w-28"
          />
        </SettingsRow>
        <SettingsRow title="窗口高度">
          <Input
            type="number"
            min={240}
            max={2400}
            value={config.windowHeight}
            onChange={(event) => save({ windowHeight: Number(event.target.value) })}
            className="w-28"
          />
        </SettingsRow>
        <SettingsRow
          title="音频延迟"
          description="远程 gateway 场景用于补偿 mouth 指令、后端渲染和 JPEG 回传延迟。"
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={2000}
              value={config.audioDelayMs}
              onChange={(event) => save({ audioDelayMs: Number(event.target.value) })}
              className="w-28"
            />
            <span className="text-xs text-muted-foreground">ms</span>
          </div>
        </SettingsRow>
        <SettingsRow title="关闭 THA 窗口">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void window.electronAPI?.tha?.closeAll()}
          >
            <RefreshCcw className="h-4 w-4" aria-hidden />
            关闭全部
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
