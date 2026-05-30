## Context

配置中已有 `agents.defaults.botName` / `agents.defaults.botIcon`（默认 `"nanobot"` / `"🐈"`），目前仅被 CLI 的 `StreamRenderer` 消费——在终端中 assistant 回复前打印 `"{icon} {name}"` header。

前端（WebUI + Electron）的 Settings 页面可编辑这两个字段，文案描述为 "Shown in runtime surfaces that use the configured bot identity"，但聊天 thread 组件实际并未消费它们。assistant 消息以「裸 Markdown 文档」风格渲染，没有任何身份标识。

现有基础设施：
- **后端**：`/api/settings` 返回 `agent.bot_name` / `agent.bot_icon`
- **media 托管**：`~/.nanobot/media/` 通过 HMAC 签名路由 `/api/media/<sig>/<payload>` 提供访问；签名每次重启重新生成
- **WebUI**：`ThreadShell` → `ThreadViewport` → `ThreadMessages` → `MessageBubble`
- **Electron**：`InboxView` → `ThreadViewport` → `ThreadMessages` → `MessageBubble`；Electron 渲染进程使用 `resolveMediaUrl()` 将相对路径拼上网关 apiBase

用户需求参考（Telegram 截图）：bot 名称显示在 AI 回复消息左侧，附带圆形头像图片。

## Goals / Non-Goals

**Goals:**
- 在 WebUI 和 Electron 的 assistant 消息旁展示 bot 身份标识（圆形头像 + name）
- 头像优先使用图片文件（`~/.nanobot/media/avatar.{jpg,png,webp}`）；不存在时降级为 `botIcon` emoji
- 改动最小化：新增一个公开的 `/api/avatar` 路由服务头像文件，不走 HMAC 签名
- 展示样式与现有文档式布局协调

**Non-Goals:**
- 不支持通过 Settings UI 上传头像图片（本期手动放置文件到 media 目录）
- 不改变 user 消息的展示样式
- 不修改 `AgentActivityCluster`（thinking/tool trace 区块）的展示

## Decisions

### D1: 头像图片服务——新增公开 `/api/avatar` 路由

**选择**：在 WebSocket channel 的 `_dispatch_http` 中新增 `/api/avatar` 路由，直接从 `get_media_dir()` 根目录查找 `avatar.{jpg,png,webp}`（按扩展名优先级），找到则返回文件内容+对应 MIME，未找到则 404。此路由不需要 token 鉴权。

**理由**：
- 现有 `/api/media/<sig>/<payload>` 使用 HMAC 签名，每次重启 secret 变化，前端无法硬编码固定 URL
- 头像是公开信息（不含敏感数据），单独路由免签名是合理的
- 实现极简：约 15 行 Python 代码

**替代方案**：
- 在 settings API 返回签名 URL：可行但需要前端在每次 settings 刷新时更新头像 URL，且 URL 重启失效
- 在 Electron 中直接读 `file://` 路径：仅解决 Electron 端，WebUI 仍需 HTTP 路由

### D2: Settings API 新增 `bot_avatar_url` 字段

**选择**：在 `/api/settings` 返回的 `agent` 对象中新增 `bot_avatar_url: string | null`。后端检测 `get_media_dir() / avatar.{jpg,png,webp}` 是否存在，存在时返回 `"/api/avatar"`，否则 `null`。

**理由**：前端通过此字段判断是否有自定义头像，决定显示图片还是 emoji 降级。

### D3: 数据注入方式——React Context

**选择**：创建 `BotIdentityContext`，提供 `{ botName: string; botIcon: string; botAvatarUrl: string | null }`。由 `ThreadShell`（WebUI）和 `App.tsx`（Electron）从 settings state 注入 Provider。`MessageBubble` 内部通过 `useContext` 消费。

**理由**：
- bot 身份是全局不变量（仅 settings 变更时更新），Context 避免逐层 prop 穿透
- `ThreadMessages` → `MessageBubble` 之间还有 `DisplayUnit` 分组逻辑，不宜在每层增加 prop

### D4: 展示布局——左列头像 + 右列内容/footer

**选择**：将 `MessageBubble` 的 assistant 分支改为两列 flex 布局：

```
┌──────┬──────────────────────────────────────────┐
│      │  ReasoningBubble（若有）                  │
│      │  MarkdownText / TypingDots               │
│ 头像 │  media                                   │
│      │                                          │
│ 靠下 │  [botName]  [copy]  [latency]            │
└──────┴──────────────────────────────────────────┘
```

- **左列**：宽 32px，`flex-none`，`flex items-end`（头像靠底部对齐）
- **右列**：`flex-1 min-w-0`，保持现有内容结构不变
- **头像**：24×24 圆形，优先 `<img>` 加载 `botAvatarUrl`，`onError` 降级为 emoji / 首字母
- **`botName`**：移入 footer row（原 copy + latency 所在 div），位于最左侧，`text-xs font-medium text-muted-foreground`
- footer row 条件不变：`showAssistantFooterRow` 仍由 copy 和 latency 决定；`botName` 始终随 footer 一同出现（即有内容的 assistant 消息才显示）

**理由**：
- 用户期望：头像单独一列在左侧、靠下对齐复制/耗时区域，名称与 copy/latency 在同一行且与正文对齐
- 与现有 copy/latency footer 结构共用一行，避免新增额外 DOM 层级
- 左列固定宽度，右列正文不受干扰

### D5: 无 avatar 图片时的降级

**选择**：`botAvatarUrl` 为 `null` 或图片加载失败时，显示 `botIcon` emoji 作为头像（居中在 24×24 圆形 `bg-muted` 背景中）。若 `botIcon` 也为空，显示 `botName` 首字母大写。

### D6: 同一 turn 中身份标识去重

**选择**：所有 assistant 文本消息都显示左列头像。实现最简单，先观察效果，必要时再做 turn 维度去重。

### D7: ReasoningBubble 与左列头像的关系

**选择**：`ReasoningBubble` 位于右列顶部，左列头像靠底部对齐（`items-end`），因此 reasoning 展开时头像不会移动。TypingDots 期间（空内容流式）不展示身份行（左列头像和 footer 均不显示），与原有逻辑一致。

## Risks / Trade-offs

- **[/api/avatar 无鉴权]** 头像图片可被任意访问 → 头像是公开信息，风险可接受
- **[文件名约定]** 用户需手动放置 `avatar.{jpg,png,webp}` 到 `~/.nanobot/media/` → 后续可在 Settings UI 增加上传功能
- **[Electron / WebUI 代码重复]** 两端各自实现 Context + header 展示 → 与 settings 组件同理，后续可抽共享包
- **[每条消息都带身份行]** 可能略显冗余 → 先发布观察，不满意再改为 turn 首条
