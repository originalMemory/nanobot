# 附录：关键入口文件

[← 目录](./README.md)

## nanobot

| 用途 | 文件 |
|------|------|
| CLI | `nanobot/cli/commands.py` |
| Gateway | `nanobot gateway`（commands.py） |
| Agent 核心 | `nanobot/agent/loop.py`, `runner.py` |
| 消息总线 | `nanobot/bus/queue.py` |
| 配置 | `nanobot/config/schema.py` |
| 架构约束 | `.agent/design.md` |
| 记忆实现 | `nanobot/agent/memory.py` |
| 上下文构建 | `nanobot/agent/context.py` |

## OpenClaw

| 用途 | 文件 |
|------|------|
| CLI 入口 | `openclaw.mjs` → `src/entry.ts` |
| Gateway 架构说明 | `docs/concepts/architecture.md` |
| 插件架构 | `docs/plugins/architecture.md` |
| 上下文文件注入 | `docs/concepts/context-files-injection.md` |
| 记忆概览 | `docs/concepts/memory.md` |
| Dreaming | `docs/concepts/dreaming.md` |
| 仓库规范 | `AGENTS.md` |
| 产品愿景 | `VISION.md` |
