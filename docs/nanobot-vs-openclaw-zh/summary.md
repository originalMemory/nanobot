# 总结

[← 目录](./README.md)

**nanobot** 是面向「可读核心 + 实用部署」的 **Python 轻量 Agent 框架**：用 `MessageBus` 解耦通道与 `AgentLoop`/`AgentRunner`，在较小代码规模内集成多通道、多 Provider、记忆、MCP、WebUI 与 OpenAI API。其架构文档与 `.agent/design.md` 一致地约束核心膨胀，把创新推向通道、工具和 Skill。

**OpenClaw** 是面向「个人 AI 助手产品」的 **Node/TS 平台**：以 **Gateway** 为唯一控制平面，通过 WebSocket 协议统一 CLI、Web、原生 App 与 Node 设备；通过 **能力化插件系统**（`extensions/` + plugin-sdk）承载绝大多数 Provider、通道与媒体能力，并配套 macOS/iOS/Android 客户端与 Canvas 等高级特性。

从演进关系看，nanobot 适合作为 **学习 OpenClaw 思想、在 Python 栈快速落地** 的选择；OpenClaw 适合作为 **长期运行的全功能个人助手操作系统**。二者在通道名、Skill、Dream 记忆、Gateway 概念上高度同源，差异主要体现在 **运行时语言、中心化协议、插件规模与客户端矩阵** 四个维度。

## 专题索引

| 主题 | 文档 |
|------|------|
| 工作区文件、`IDENTITY.md` vs `identity.md` | [workspace-identity.md](./workspace-identity.md) |
| 每日记忆、`history.jsonl`、Dream 提炼/淘汰、上下文占用 | [memory.md](./memory.md) |
| 数据流与 Agent 循环 | [core-architecture.md](./core-architecture.md) |
| 主会话 / 跨通道统一上下文 | [sessions.md](./sessions.md) |
| 选型 | [selection-guide.md](./selection-guide.md) |

**下一步**：[附录：入口文件](./appendix.md)
