# Spec: add-electron-reasoning-controls

## Why
- Electron 能展示 reasoning 流，但缺少思考模式配置入口。
- 后端已有 `reasoning_effort` 全局和 preset 字段，Electron UI 需补齐设置与快捷切换入口。

## Scope
- 本次要做：Electron 设置页模型分区新增全局 `reasoning_effort` 配置。
- 本次要做：模型 preset 创建/编辑支持单独配置 `reasoning_effort`。
- 本次要做：输入框底部新增思考模式快捷切换按钮，修改当前全局或 active preset 的思考模式。
- 本次要做：补齐必要类型、i18n 和 settings API glue。
- 本次不做：翻译模型 reasoning 内容。
- 本次不做：WebUI 同步改版，除非复用类型/API 必须调整。
- 本次不做：新增复杂 provider 能力检测；不支持的模型按现有 provider 行为处理。

## Plan
- [x] 查清 Electron 当前 `/api/settings` 数据流、模型 preset 表单和消息发送 payload。
- [x] 在 Electron 模型设置中添加全局 `reasoning_effort` 选择器，保存到 `/api/settings/update`。
- [x] 在 preset 创建/编辑 UI 中添加 `reasoning_effort` 字段；后端 create/update 路径缺字段时补齐。
- [x] 在 ThreadComposer 底部添加思考模式按钮，支持 `default` 和 `off/on` 快捷状态；选择后保存到 settings。
- [x] settings 更新后刷新运行时 provider generation 配置，避免需要重启才生效。
- [x] 补齐 Electron 类型和中英文 i18n 文案。
- [x] 补测试：settings API/preset 字段、Electron 设置页渲染保存、Composer toggle payload。

## Apply Notes
- `reasoning_effort=null` 表示 provider/default；`none` 表示显式关闭。
- preset 级配置优先于全局默认；composer 快捷按钮等价于保存当前 active preset / 默认配置。
- UI 文案用“思考模式”，值展示为“默认 / 关闭 / 低 / 中 / 高 / 自适应”。
- 不把 Electron 外观语言当模型语言偏好；按钮只控制 reasoning effort。
- WebSocket 消息发送格式不新增 `reasoning_effort` 字段；思考模式通过 settings API 持久化。

## Verify
- [x] Electron 设置页加载后能显示当前全局 `reasoning_effort`，修改后刷新仍保留。
- [x] preset 创建/编辑后，`/api/settings` 返回该 preset 的 `reasoning_effort`。
- [x] 输入框切换到关闭后，settings 返回并持久化 `reasoning_effort=none`。
- [x] 输入框恢复默认后，settings 清空当前 active preset / 默认配置中的 `reasoning_effort`。
- [x] 现有 reasoning 展示和 `reasoning_delta` / `reasoning_end` 渲染不回退。

## Status
- State: done
- Archived: no
