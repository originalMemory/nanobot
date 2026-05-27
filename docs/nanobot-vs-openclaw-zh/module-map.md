# 模块映射速查

[← 目录](./README.md)

| 概念 | nanobot 路径 | OpenClaw 路径 |
|------|--------------|---------------|
| 消息中枢 | `nanobot/bus/` | `src/gateway/` |
| Agent 编排 | `nanobot/agent/loop.py` | `src/agents/` + `src/auto-reply/` |
| LLM 调用循环 | `nanobot/agent/runner.py` | agents + provider plugins |
| 通道 | `nanobot/channels/` | `src/channels/` + `extensions/*` |
| 模型后端 | `nanobot/providers/` | `extensions/*` + `src/plugin-sdk` |
| 工具 | `nanobot/agent/tools/` | `src/tools/` + plugins |
| 会话 | `nanobot/session/` | `src/sessions/` |
| 记忆 | `nanobot/agent/memory.py` | `src/memory/` + memory extensions |
| 配置 | `nanobot/config/` | `src/config/` |
| CLI | `nanobot/cli/` | `src/cli/` + `src/commands/` |
| Web 前端 | `webui/` | `ui/` |
| 定时任务 | `nanobot/cron/` | `src/cron/` |
| 配对 | `nanobot/pairing/` | `src/pairing/` |
| Skills | `nanobot/skills/` | `skills/` |
| 插件机制 | entry-point + registry | `extensions/` + `src/plugins/` + plugin-sdk |
| HTTP/WS 服务 | gateway 命令 + `api/` + `webui/` | `src/gateway/` |

**下一步**：[总结](./summary.md)
