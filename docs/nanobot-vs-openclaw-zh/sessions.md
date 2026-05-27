# 会话与跨通道上下文

[← 目录](./README.md)

## 默认行为：按通道 × 聊天隔离

nanobot 默认与 OpenClaw「群组/话题各一套 session」类似：**每个入口一条会话线**。

会话键（`session_key`）默认规则（`nanobot/bus/events.py`）：

```text
session_key = "{channel}:{chat_id}"
```

例如：

- `telegram:8281248569` — 某 Telegram 私聊  
- `discord:123456789` — 某 Discord 频道或 DM  
- `cli:local` — 本地 CLI  

各自有独立的 `Session.messages`、压缩游标、`/new` 范围。在 Telegram 说的话**不会**自动出现在 Discord 的上下文里。

OpenClaw 侧对应概念：

- **主会话（main session）**：多个 DM / 设备默认折叠到 `agent:<id>:<mainKey>`，共享连续对话。  
- **群组 / 频道 / 话题**：独立 `session_key`（Telegram topic、Discord thread 等）。  
- **MEMORY.md 等**：文档写明常在 **main session** 加载；群聊有单独策略。

nanobot **没有** 名为 `main` 的配置键，但语义上默认的 `channel:chat_id` 就是「每个聊天窗口一条线」。

---

## 跨通道统一上下文：`unifiedSession`

若希望 **Telegram、Discord、CLI、WebUI 等全部进同一条对话**，打开配置项 **`agents.defaults.unifiedSession`**（默认 `false`）。

```json
{
  "agents": {
    "defaults": {
      "unifiedSession": true
    }
  }
}
```

实现（`nanobot/agent/loop.py`）：

- 所有未带 `session_key_override` 的入站消息 → 固定键 **`unified:default`**（常量 `UNIFIED_SESSION_KEY`）。  
- 从手机 Telegram 切到 Discord，**同一份** `Session.messages`、同一套 Consolidator / Dream 所见的对话历史（工作区记忆文件本来就是全局的，与 session 无关）。

| | `unifiedSession: false`（默认） | `unifiedSession: true` |
|---|-------------------------------|-------------------------|
| 会话键 | `channel:chat_id` | `unified:default` |
| 跨通道连续对话 | ❌ | ✅ |
| `/new` 清空范围 | 当前 channel 会话 | **共享**会话（所有通道一起清） |
| `/stop` 取消任务 | 按 channel 会话 | 按共享会话 |
| 适用场景 | 多人群聊、每端独立上下文 | **单用户、多设备/多 App** |

官方说明见 [`../configuration.md`](../configuration.md) 的 **Unified Session** 一节。

### 与 OpenClaw「主会话」的对应关系

| OpenClaw | nanobot |
|----------|---------|
| DM 默认进 main session | 需显式 `unifiedSession: true` 才合并所有通道 |
| 群 / 话题独立 session | 默认已是 `channel:chat_id` 隔离；话题可用 `session_key_override` |
| `session.mainKey` / agent 多实例 | 单配置下仅一个 `unified:default`；多实例用不同 `--config` + workspace |
| Heartbeat 跑在 main session | Heartbeat 用工作区 `HEARTBEAT.md`，投递到「最近活跃通道」，与 unified 无硬绑定 |

结论：**nanobot 有等价的「全通道一条会话」能力，但叫 unified session，且默认关闭**；OpenClaw 对私聊默认就更接近「主会话」，nanobot 对多通道默认是分开的。

---

## 仍会被单独分 session 的情况

即使 `unifiedSession: true`，下列情况**不会**被强行并进 `unified:default`：

| 情况 | 行为 |
|------|------|
| **`session_key_override`** | 通道若传入覆盖键（如 Telegram 话题、Discord 线程），仍用该键 — 配置文档明确 **仍尊重 override** |
| **WebUI 多会话** | WebUI 侧可为不同 thread 使用不同 `sessionKey`（与 gateway 协议一致时） |
| **子 Agent** | `spawn` 等使用独立上下文；完成后结果回传主会话 |
| **多 nanobot 实例** | 不同 `--config` / workspace → 完全隔离 |

因此：unified 是「所有**未 override** 的通道共用一个键」，不是「世界上只有一条 session」。

---

## 统一 session 时，记忆与工具是否也统一？

| 维度 | 是否统一 |
|------|----------|
| **对话 transcript**（`Session.messages`） | ✅ `unifiedSession` 下统一 |
| **工作区文件**（`SOUL.md`、`MEMORY.md`、`history.jsonl`） | ✅ 本来就按 workspace 全局一份 |
| **运行时元数据**（通道名、chat_id） | 每轮仍带在 Runtime Context 里，模型知道「这条从 Telegram 来」 |
| **回复投递** | 仍回**当前入站消息**的 channel/chat_id，不会自动广播到所有通道 |
| **cron / 提醒** | 创建任务时需带目标 `channel` + `chat_id`（见 `AGENTS.md` 模板） |

---

## 选型建议

- **一个人、多端接力同一个助手** → `unifiedSession: true`。  
- **同一 bot 服务多个群 / 多个客户** → 保持默认 `false`，避免串台。  
- **只要 Telegram 私聊 + CLI 合并，群聊分开** → 默认即可；或依赖各通道的 `session_key_override` 精细控制（需通道实现支持）。

## WebUI 里有「main」吗？

**没有 OpenClaw 那种命名的 main session**，WebUI 是**多对话（多 thread）**模型。

| 概念 | nanobot WebUI |
|------|----------------|
| 侧边栏一条对话 | 一个 `chat_id`（UUID），后端会话键为 **`websocket:{chat_id}`** |
| 新建对话 | 发 `new_chat`，服务器分配新 `chat_id` → 新 thread |
| 「默认打开哪条」 | 连接后服务器的 **`defaultChatId`**（首个就绪 chat），**不是**「主会话」语义，只是初始 tab |
| 固定/置顶 | `pinned_keys`、标题覆盖、归档（sidebar state API） |
| 与 Telegram 合并 | 仅当全局 **`unifiedSession: true`** 时，WebUI 消息在 Agent 侧也进 `unified:default`；侧边栏仍显示多条 `websocket:…` |

注意：`unifiedSession: true` 时，**多条 WebUI 对话在 UI 上分开**，但 **Agent 的 `Session.messages` 可能共用 `unified:default`**（与 Telegram 等同一条大脑）；各 thread 另有 **WebUI 专用 transcript**（`webui` transcript 文件）做展示。默认 `unifiedSession: false` 时，每个 WebUI thread 对应独立的 `websocket:{chat_id}` agent 会话。

OpenClaw Control UI 常见「按 agent 选 main session」；nanobot WebUI **不区分 main / 非 main**，只有多条 `websocket:*` 会话列表。

### 开 `unifiedSession` 后，记忆与 Dream 也合并吗？

**工作区记忆本来就是全局一份**（与是否 unified 无关）：

| 对象 | 是否跨通道共享 |
|------|----------------|
| `SOUL.md` / `USER.md` / `memory/MEMORY.md` | ✅ 整个 workspace 一份 |
| `memory/history.jsonl` | ✅ 整个 workspace 一份 |
| **Dream** | ✅ 读全局 jsonl，写全局三文件 |
| **GitStore** | ✅ 跟踪上述长期文件 |

**会随 unified 合并的是「对话 transcript」层**：

| 对象 | `unifiedSession: true` 时 |
|------|---------------------------|
| Agent `Session.messages` | ✅ 全部进 **`unified:default`**（Telegram、WebUI、CLI…） |
| **Consolidator** 压进去的 jsonl 摘要 | ✅ 来自这条共享会话，**一起进 Dream 流水线** |
| 各通道各自的 `telegram:…` session 文件 | ❌ 新消息不再单独积累（未 override 时） |

结论：**Dream 沉淀的是「全通道汇到 unified 后的对话摘要 + 全局长期文件」**，不是「每个 WebUI thread 各梦各的」。工作区 Markdown 记忆对所有通道本来就读同一份。

### WebUI 能像 OpenClaw 那样看到其他 channel 的消息吗？

**不能（至少不是默认行为）。** nanobot 把 **Agent 会话** 和 **WebUI 展示 transcript** 拆开了。

```text
nanobot/webui/transcript.py 首行说明：
Append-only WebUI display transcript (JSONL), separate from agent session.
```

| 数据来源 | 里有什么 |
|----------|----------|
| **`websocket:{chat_id}` transcript** | 仅该 WebUI 对话里收发的 UI 事件（用户发送、助手回复流等） |
| **`unified:default` agent session** | Telegram / 各 WebUI thread / CLI 等汇入的**模型上下文**（unified 开启时） |
| **Sessions HTTP API** | 列表**只返回** `websocket:*` 键，不暴露 `telegram:*` 或 `unified:default` |

因此：

- 在 Telegram 说的话：**会**进入 unified 下的 Agent 大脑（若开了 unified），模型在 Telegram 里能接着聊。
- 在 WebUI 某条 thread 的聊天窗口里：**默认看不到** Telegram 的原文气泡；只能看到该 `chat_id` 的 WebUI transcript。
- OpenClaw Web 聊天更接近「盯着 main / 选定 session 的 transcript」；nanobot WebUI 是 **per-thread 展示层**，不是全通道收件箱。

若要在 WebUI 里「看见别的通道」，目前没有一等能力；变通只能依赖模型在 unified 上下文里记住的内容（回答时提及），或自己用 `grep` / 读 session 文件（且 API 未把 `unified:default` 当 WebUI thread 提供）。

**下一步**：[核心架构](./core-architecture.md) · [记忆系统](./memory.md) · [配置 Unified Session](../configuration.md#unified-session)
