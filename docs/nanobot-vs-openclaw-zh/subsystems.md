# 子系统对照表

[← 目录](./README.md)

## 聊天通道（Channels）

| | nanobot | OpenClaw |
|---|---------|----------|
| 实现位置 | `nanobot/channels/*.py`（内置） | `src/channels/` + `extensions/*` 通道插件 |
| 数量级 | ~15 个内置（Telegram、Discord、Slack、飞书、Matrix、WhatsApp、QQ、微信、企业微信、钉钉、Email、MoChat、MS Teams、Signal、WebSocket 等） | 文档宣称 20+ 渠道，含 IRC、LINE、Nostr、Twitch、Zalo 等 |
| 扩展方式 | entry-point 插件 + `channels/registry.py` | `api.registerChannel(...)` 能力注册 |
| 特色 | 通道文件允许重复逻辑，避免过早抽象（design 约束） | 通道与核心通过 plugin-sdk 边界交互 |

## 模型提供商（Providers）

| | nanobot | OpenClaw |
|---|---------|----------|
| 实现 | `nanobot/providers/*`（Anthropic、OpenAI 兼容、Responses API、Azure、Bedrock、Copilot、Codex 等） | 核心通用循环 + `extensions/` 中大量 Provider 插件 |
| 工厂 | `factory.py` + `registry.py` | 能力注册 `registerProvider`、manifest 元数据 |
| 降级 | `fallback_provider.py`、`fallback_models` 配置 | 插件与运行时计划（`AgentRuntimePlan` 等） |
| 多模态 | 图像生成、Whisper 转写 | 图像/音乐/视频生成、语音、实时转写等独立能力类型 |

## 工具与 MCP

| | nanobot | OpenClaw |
|---|---------|----------|
| 内置工具 | 文件系统、shell（沙箱）、web 搜索/抓取、MCP、cron、子 Agent、长任务、图像生成、self 修改等 | 核心 tools + 插件工具 |
| MCP | `agent/tools/mcp.py` | `src/mcp/` |
| 发现机制 | pkgutil + entry-point | 插件 manifest + registry |

## 配置

| | nanobot | OpenClaw |
|---|---------|----------|
| 格式 | `~/.nanobot/config.json`，Pydantic `schema.py` | OpenClaw 配置树 + Zod/schema + doctor 修复 |
| 特点 | 显式配置、camelCase 别名 | `openclaw doctor --fix` 处理遗留形状；强调无启动时隐式迁移 |

## UI 与入口

| | nanobot | OpenClaw |
|---|---------|----------|
| Web | `webui/`（React + Vite + bun），构建进 wheel | `ui/`（更大型的控制/聊天/配置界面） |
| CLI | `nanobot`（Typer），`nanobot gateway` | `openclaw`，`openclaw onboard`，`openclaw gateway` |
| 原生 App | 无 | `apps/macos`、`apps/ios`、`apps/android` |
| HTTP API | OpenAI 兼容 `/v1/chat/completions` | Gateway WS 为主；另有 WebChat 等 |
| 默认端口 | Gateway **8765** | Gateway **18789** |

## 安全与配对

| | nanobot | OpenClaw |
|---|---------|----------|
| DM 配对 | `nanobot/pairing/` 持久化配对码 | 设备身份 + Gateway 配对存储 |
| Shell | 沙箱后端、allow-list | 执行审批、exec approval UI |
| 其他 | PTH guard、工作区边界 | 完整 SECURITY.md、Tailscale、trusted-proxy 等 |

## 自动化

| | nanobot | OpenClaw |
|---|---------|----------|
| 定时 | `cron/` + cron 工具 + Heartbeat | `cron/` + Gateway 事件 |
| Skills | `nanobot/skills/*/SKILL.md` | `skills/` 目录 + ClawHub 生态 |
| 部署 | Docker、LaunchAgent、systemd 文档 | Docker、daemon（launchd/systemd）、Nix、Fly 等 |

## 会话（Sessions）

| | nanobot | OpenClaw |
|---|---------|----------|
| 默认会话键 | `channel:chat_id` | DM 常折叠到 **main session**；群/话题独立 |
| 跨通道一条上下文 | `unifiedSession: true` → `unified:default` | 多 DM/设备默认共享 main |
| 话题/线程 | `session_key_override` | 独立 session key |

详见 [sessions.md](./sessions.md)。

**下一步**：[工作区与身份](./workspace-identity.md) · [记忆系统](./memory.md)
