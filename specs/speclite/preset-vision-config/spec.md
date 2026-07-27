# Spec: preset-vision-config

## Why
- preset 需要独立保存辅助视觉模型，避免切换后沿用其他配置。

## Scope
- `vision_model` 为空时图片直达主模型；有值时 use 辅助视觉模型。
- `vision_provider` 为空时按 `vision_model` 自动识别 provider。
- 每个 preset 固定 use 自己的视觉配置，不继承 default。
- 设置 API 返回每个 preset 的视觉模型和 provider。
- Electron 按 preset 编辑视觉模型和可空 provider。
- 不修改浏览器 `webui/`、思考模式、模型 ID、价格。

## Plan
- [x] 简化 preset 视觉解析为固定覆盖。
- [x] 修正运行时切换和 provider 创建失败后的状态。
- [x] 简化设置 API 和 Electron 视觉配置 UI。
- [x] 撤回前后端思考模式改动。
- [x] 更新后端与 Electron 回归测试。

## Apply Notes
- 不新增视觉 mode；`None` 是正常配置值，不是额外哨兵。
- named preset 不回退到 `agents.defaults`；旧 preset 未配置 `vision_model` 时改为主模型直接识图。
- provider 创建失败时清空辅助视觉状态，不沿用上一个 preset。
- Electron 全量 TypeScript 检查仍被既有的 PSB、App、TTS、`useAttachedImages` 错误阻塞；本次改动文件未出现在错误列表中。

## Verify
- [x] named preset 空视觉模型时不启用 caption。
- [x] preset 视觉模型固定覆盖，空 provider 自动识别。
- [x] provider 创建失败后不残留旧辅助视觉 provider。
- [x] Electron 可清空视觉模型和 provider。
- [x] 前后端思考模式恢复原有行为。
- [x] 后端针对性 pytest、Electron Vitest 和改动文件 lint 通过。

## Status
- State: done
- Archived: yes
