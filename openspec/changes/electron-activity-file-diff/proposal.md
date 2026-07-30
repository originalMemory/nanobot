## Why

Electron 的 Activity 展示仍由单个大型组件承担，文件编辑缺少 v0.3.0 WebUI 已有的结构化 Diff。需要在保留 Electron 独立 renderer 与现有消息语义的前提下，先拆出 reasoning 与文件编辑展示，并改善活动时间线。

## What Changes

- 将 reasoning 和文件编辑拆为独立子组件；Web Search、MCP、CLI 和通用工具暂时保留在现有容器中。
- 为单文件、多文件编辑提供结构化 Diff 与语法高亮。
- 根据活动是否包含非 reasoning 操作展示“思考中/思考了”或“处理中/处理了”，并显示持续时间。
- 融合备份分支的动态壁纸对比度和思考折叠后贴底行为。
- 保留 Electron 现有 Activity 外层折叠、消息聚合、助手身份、footer、TTS 和消息分段逻辑。

## Capabilities

### New Capabilities

- `electron-activity-display`: Electron 对 reasoning、工具活动和文件 Diff 的结构化展示、状态文案及滚动稳定行为。

### Modified Capabilities

无。

## Impact

- 主要影响 `electron/src/renderer/components/thread/`、Activity 相关前端工具函数、样式和 i18n。
- 复用 upstream v0.3.0 WebUI 的 Activity/File Diff 设计，但不修改或加载 root `webui/`。
- 默认不修改后端 HTTP/WebSocket 协议；只有现有事件缺少渲染所需字段时才补最小 payload。
- 不改变统一会话、Cron、模型切换、音频播放、动态壁纸和桌宠行为。
