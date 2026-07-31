# Spec: global-vision-assistance

## Why
- 视觉辅助模型重复配置在每个 preset，切换和迁移易丢配置。
- preset 只需决定是否启用统一视觉辅助。

## Scope
- `agents.defaults` 保存全局 `visionModel` / `visionProvider`。
- default 与具名 preset 保存 `visionEnabled`；具名 preset 不再保存视觉模型/provider。
- Electron 设置全局视觉模型/provider，并为当前 preset 设置启用开关。
- 修复 preset 编辑后的重复 fallback、设置接口异常处理。
- 不改直接向主模型发送图片的逻辑，不改 root WebUI 前端。

## Plan
- [x] 调整 schema、视觉解析和运行时 preset 切换。
- [x] 调整设置 API 与 Electron 表单。
- [x] 修复 review 中其余问题。
- [x] 更新配置、后端与 Electron 测试。
- [x] 修复 implicit default 的 `visionEnabled=false` 启动失效。
- [x] 视觉 provider 热更新 use 最新配置。

## Apply Notes
- 兼容读取 preset 内旧 `visionModel` / `visionProvider`，迁移时提升为全局配置后不再输出到 preset。
- `visionEnabled=false` 时跳过辅助 caption，图片仍按现有能力交给主模型。
- 用户本轮已明确要求实施。

## Verify
- [x] 所有 preset 共用一套全局视觉模型/provider。
- [x] 切换 preset 只切换视觉辅助开关。
- [x] preset 编辑不产生重复调用链。
- [x] 相关 Python、Electron 测试与打包通过。
- [x] 默认 preset 禁用视觉辅助后，启动不创建视觉 provider。
- [x] 热更新视觉配置时 use 最新 provider 凭证。

## Status
- State: done
- Archived: yes
