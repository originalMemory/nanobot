# 扩展模型：最大架构差异

[← 目录](./README.md)

## nanobot：轻量插件 + 边缘扩展

```
核心（loop/runner）── 尽量不改
    ├── channels/     新通道
    ├── agent/tools/  新工具
    ├── providers/    新模型后端
    ├── skills/       提示词与流程 Skill
    └── MCP 外部服务
```

- 通道与工具支持 **setuptools entry-point** 与包内 `pkgutil` 扫描。
- 原则：**能放通道适配器、工具或 MCP 的，不进 Agent 核心**。

## OpenClaw：能力导向的插件平台

```
核心（gateway、agents、config）── 与具体厂商/通道 ID 解耦
    ├── extensions/（~131 包）
    │     ├── 文本推理 Provider
    │     ├── 通道 Channel
    │     ├── 图像/语音/视频/搜索/抓取…
    │     └── hook-only 遗留形态
    └── plugin-sdk/（稳定对外契约）
```

能力类型（节选）：`registerProvider`、`registerChannel`、`registerImageGenerationProvider`、`registerWebSearchProvider`、`registerSpeechProvider` 等。

**架构原则（OpenClaw AGENTS.md）**：

- 核心不得硬编码捆绑插件 ID。
- 扩展只能通过 `openclaw/plugin-sdk/*` 与 manifest 进入核心。
- 热路径避免重复「全量发现」插件/Provider（使用 prepared runtime facts）。
- 配置迁移走 `doctor --fix`，而非启动时隐式兼容。

nanobot **没有** 等价的 `extensions/` monorepo 与 plugin-sdk 分层；扩展面更扁平，适合 Python 生态与小型团队维护。

**下一步**：[技术栈](./tech-stack.md)
