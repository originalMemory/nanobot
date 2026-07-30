## Context

`lover` 的 Electron renderer 保留了独立发布、统一收件箱、动态壁纸、TTS 和助手身份展示，但 Activity 仍集中在一个约 1900 行的组件中。upstream v0.3.0 已将 reasoning、Web、MCP、通用工具和文件编辑拆为独立的数据模型与视图，并修正了活动时长和“思考/处理”状态文案。

当前后端文件编辑事件已经包含路径、状态、增删行数和删除操作，但没有携带可渲染的 unified diff。Electron 因而只能展示计数，不能展示真实改动。此次变更需要同时调整最小后端事件字段和 Electron renderer，但不得改变 Session、Cron、Heartbeat、模型、音频或统一收件箱语义。

## Goals / Non-Goals

**Goals:**

- 在 Electron 内拆出 reasoning 和文件编辑子组件，保留既有 Web、MCP、CLI 和通用工具结构化展示。
- 文件编辑完成后可在 Activity 内展开 unified diff，并按文件类型进行语法高亮。
- 有工具活动时使用“处理中/处理了”，只有 reasoning 时使用“思考中/思考了”，时长覆盖首条活动出现前的等待时间。
- 保持流式期间自动跟随，并在折叠导致内容高度变化时仅为原本贴底的用户维持底部可见。
- 提升动态壁纸下 Activity 摘要、展开内容和助手 footer 的可读性。

**Non-Goals:**

- 不把 Electron 改为远端 WebUI 套壳，也不修改 root `webui/`。
- 不引入 Session 级模型切换、Prompt 导航、Session 信息面板或 Automation UI；它们属于后续批次。
- 不改变统一会话、消息聚合、助手身份、TTS、消息分段、Cron/Heartbeat 或音频行为。
- 不增加文件写入、文件预览 API 或任意路径读取能力。

## Decisions

### 1. 复用 v0.3.0 的 Activity 模型，保留 Electron 外层容器

将 upstream 的 reasoning 与文件编辑模型和小组件移植到 `electron/src/renderer/components/thread/activity/`，但继续由 Electron 现有 `AgentActivityCluster` 负责 Web、MCP、CLI、通用工具、折叠生命周期、消息分段和客户端特有数据。

替代方案是整文件覆盖 `AgentActivityCluster`。该方案会丢失 Electron 已有的 CLI/MCP 展示、消息聚合和定制样式，回归面过大，因此不采用。

### 2. 文件 Diff 使用事件快照，不通过点击后读取文件

后端在文件编辑结束时，使用执行前后的 UTF-8 文本快照生成有限长度的 standard unified diff，并放入现有 `file_edit` 事件的可选 `diff` 字段。Electron 将其解析后在对应文件行下方按需展开。

这样展示的是“本次工具调用实际造成的改动”，不会因文件之后再次变化而失真，也不需要开放新的文件读取接口。二进制、过大、不可读或无改动文件继续只展示状态和计数。

### 3. Diff payload 必须受限且向后兼容

`diff` 是可选字段，旧客户端会忽略它；Electron 遇到旧 gateway 或缺失字段时退化为增删计数。后端限制 diff 行数和单行长度，并标记 `truncated`，避免大型写入把 WebSocket 帧和历史记录撑大。

解析采用已有的 `diff` npm 包，语法高亮继续复用 Electron 已安装的 `react-syntax-highlighter`，不自建 patch parser 或高亮器。

### 4. 状态时长以 turn 起点为优先

Activity 组件接收当前 turn 的 `startedAtMs`。流式时从 turn 起点计时；历史回放优先使用持久化的 `turnLatencyMs`，缺失时才以活动消息时间估算。存在任何非 reasoning 活动时，文案使用“处理中/处理了”。

### 5. 贴底状态由视口在尺寸变化前记录

外层消息视口在内容 resize 前记录用户是否位于底部附近。Activity 折叠或展开改变高度后，仅当用户原先贴底时滚动到底部；正在阅读历史时不抢滚动位置。

### 6. 壁纸可读性使用局部 class hook

为 Activity 摘要、Activity 详情和助手 footer 增加稳定 class hook，仅在动态壁纸样式作用域内提高前景色透明度并添加轻微阴影。不提高整个消息面板不透明度，以免再次遮住壁纸。

## Risks / Trade-offs

- [Diff 增大实时帧和 transcript 体积] → 限制正文行数与单行长度，仅在文件编辑完成且文本可计数时生成。
- [移植 Activity 模型可能改变现有特殊 trace 展示] → 仅抽离 reasoning 和文件编辑，保留 Electron 容器与现有 Web、MCP、CLI 和通用 trace fallback。
- [语法高亮懒加载时短暂显示纯文本] → 提供无高亮 fallback，加载完成后原位替换。
- [折叠和流式更新可能触发滚动抖动] → Activity 内滚动与消息外层滚动分别维护“接近底部”状态，并用 animation frame 合并滚动。
- [旧 gateway 不包含 diff] → UI 自动退化为当前的增删计数，不阻断 Activity 展示。

## Migration Plan

1. 先发布包含可选 `diff` 字段的 gateway；旧 Electron 不受影响。
2. 再发布 Electron renderer；它同时兼容有无 `diff` 的 gateway。
3. 回滚 Electron 时无需迁移数据；回滚 gateway 时 Electron 自动退化。

## Open Questions

无。文件 Diff 本轮采用 Activity 内联按需展开，不引入完整文件预览侧栏。
