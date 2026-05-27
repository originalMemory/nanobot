# 定位与关系

[← 目录](./README.md)

| 维度 | nanobot | OpenClaw |
|------|---------|----------|
| 一句话定位 | 超轻量、可读性优先的开源 AI Agent 框架 | 面向个人的全功能 AI 助手与控制平面 |
| 设计哲学 | 核心 Agent 循环保持小而清晰；能力在边缘扩展 | 核心保持精简；能力通过插件/扩展承载 |
| 彼此关系 | nanobot README 明确致敬 OpenClaw，属于同一路线上的「轻量实现」 | 更完整的产品级方案，含原生 App、Canvas、Node 等 |
| 目标用户 | 开发者、希望快速部署个人 Agent 的用户 | 希望「真正做事」、跨设备/多渠道的个人助手用户 |
| 运行时 | Python 3.11+（asyncio） | Node 22+ / 24（TypeScript ESM） |
| 包管理 | PyPI `nanobot-ai`，单 wheel 打包 WebUI | npm `openclaw`，pnpm monorepo |

**结论**：两者是「同族不同量级」——OpenClaw 是功能完备的控制平面 + 生态；nanobot 是有意裁剪后的 Python 轻量版，保留通道、记忆、MCP、WebUI 等实用能力，但去掉大规模插件体系与原生客户端矩阵。

**下一步**：[目录结构](./directory-structure.md) · [总结](./summary.md)
