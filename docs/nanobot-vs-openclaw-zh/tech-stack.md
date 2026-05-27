# 技术栈对比

[← 目录](./README.md)

| 层级 | nanobot | OpenClaw |
|------|---------|----------|
| 语言 | Python 3.11+ | TypeScript (ESM strict) |
| 异步 | asyncio | Node async |
| CLI | Typer | 自研 CLI + 大量 commands |
| 前端 | React + Vite + bun | 自研 UI（Vitest 测试众多） |
| 配置校验 | Pydantic v2 | Zod / 自有 schema |
| 测试 | pytest, asyncio_mode=auto | Vitest, 分 lane 的 tsgo 类型检查 |
| 格式化/检查 | ruff | oxfmt + oxlint |
| 打包 | Python wheel（含 web dist、bridge） | tsdown 构建 dist/，npm 发布 |
| 桥接服务 | `bridge/`（如 WhatsApp TS 服务） | 通道逻辑多在 extensions 或 gateway |

**下一步**：[架构图](./diagrams.md)
