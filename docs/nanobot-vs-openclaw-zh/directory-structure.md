# 顶层目录结构对比

[← 目录](./README.md)

## nanobot 目录树（精简）

```
nanobot/
├── nanobot/              # Python 核心包
│   ├── agent/            # AgentLoop、AgentRunner、工具、记忆
│   ├── bus/              # 异步消息总线
│   ├── channels/         # 聊天通道（Telegram、Discord、飞书等）
│   ├── providers/        # LLM 提供商
│   ├── session/          # 会话、压缩、长期目标
│   ├── config/           # Pydantic 配置
│   ├── api/              # OpenAI 兼容 HTTP API
│   ├── cli/              # Typer CLI
│   ├── command/          # 斜杠命令
│   ├── cron/             # 定时任务
│   ├── heartbeat/        # 周期性唤醒
│   ├── pairing/          # DM 配对审批
│   ├── skills/           # 内置 Skill 定义
│   ├── webui/            # Gateway 侧 WebUI API
│   └── templates/        # 系统提示模板
├── webui/                # React + Vite 前端（构建进 wheel）
├── bridge/               # TypeScript 桥接（如 WhatsApp）
├── tests/                # pytest，镜像 nanobot 包结构
└── docs/                 # 仓库内文档
```

**规模参考**：`nanobot/` 下约 **141** 个 Python 源文件，整体代码量远小于 OpenClaw。

## OpenClaw 目录树（精简）

```
openclaw/
├── src/                  # TypeScript 核心（~100+ 顶层模块）
│   ├── gateway/          # WebSocket 控制平面（核心）
│   ├── agents/           # Agent 运行时与工具链
│   ├── channels/         # 通道实现（核心侧）
│   ├── auto-reply/       # 自动回复管线
│   ├── config/           # 配置与 schema
│   ├── plugins/          # 插件加载与注册
│   ├── plugin-sdk/       # 对外插件 SDK
│   ├── cron/             # 定时与调度
│   ├── memory/           # 记忆子系统
│   ├── pairing/          # 设备/通道配对
│   ├── cli/、commands/   # CLI 与命令
│   └── …                 # infra、hooks、media、tts 等
├── extensions/           # ~131 个官方/捆绑插件包
├── ui/                   # Web 管理/聊天 UI
├── apps/                 # macOS / iOS / Android 原生应用
├── skills/               # Skill 资源
├── packages/             # monorepo 子包
├── docs/                 # 完整文档站源
├── test/                 # Vitest 测试
└── scripts/              # 构建、发布、CI 脚本
```

**规模参考**：`src/` 下非测试 TypeScript 源文件约 **4500+**，外加大量 `extensions/` 与 `apps/`。

**下一步**：[核心架构](./core-architecture.md)
