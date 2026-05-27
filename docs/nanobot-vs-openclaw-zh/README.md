# nanobot 与 OpenClaw 对比（中文）

基于仓库源码与官方文档整理的架构对比，便于从 OpenClaw 迁移理解或选型。

| 对比对象 | 路径 / 版本 |
|----------|-------------|
| **nanobot** | 本仓库（v0.2.0） |
| **OpenClaw** | [openclaw/openclaw](https://github.com/openclaw/openclaw)（参考 v2026.5.6） |

## 阅读顺序

| 文档 | 内容 |
|------|------|
| [overview.md](./overview.md) | 定位、关系、一句话结论 |
| [directory-structure.md](./directory-structure.md) | 顶层目录树与代码规模 |
| [core-architecture.md](./core-architecture.md) | 数据流、Agent 循环、MessageBus vs Gateway |
| [sessions.md](./sessions.md) | 会话键、主会话 vs `unifiedSession`、跨通道统一上下文 |
| [subsystems.md](./subsystems.md) | 通道、Provider、工具、配置、UI、安全、自动化 |
| [workspace-identity.md](./workspace-identity.md) | 工作区 Markdown、`SOUL.md`、`IDENTITY.md` 与 `identity.md` |
| [memory.md](./memory.md) | 记忆分层、Dream 提炼/淘汰、上下文占用、`history.jsonl`、GitStore、FAQ |
| [extensions.md](./extensions.md) | 插件 / 扩展模型 |
| [tech-stack.md](./tech-stack.md) | 语言、测试、打包 |
| [diagrams.md](./diagrams.md) | Mermaid 架构图 |
| [philosophy.md](./philosophy.md) | 代码组织哲学 |
| [feature-matrix.md](./feature-matrix.md) | 能力对照表 |
| [selection-guide.md](./selection-guide.md) | 何时选哪一个 |
| [module-map.md](./module-map.md) | 模块路径速查 |
| [summary.md](./summary.md) | 总结 |
| [appendix.md](./appendix.md) | 关键入口文件 |

## 相关文档

- nanobot 记忆详解：[`../memory.md`](../memory.md)
- 官方站： [nanobot.wiki](https://nanobot.wiki/docs/latest/getting-started/nanobot-overview)

*最后更新：2026-05-26*
