# 工作区 Markdown 与身份设定

[← 目录](./README.md)

两者都用工作区根目录下的 Markdown 塑造 agent，但**文件种类与「身份」落点不同**。

## 注入到系统提示的文件

| 文件 | OpenClaw | nanobot |
|------|:--------:|:-------:|
| `AGENTS.md` | ✅ 优先级 10 | ✅ bootstrap 注入 |
| `SOUL.md` | ✅ 优先级 20（persona/语气） | ✅ bootstrap 注入 |
| `USER.md` | ✅ 优先级 40 | ✅ bootstrap 注入 |
| `memory/MEMORY.md` | ✅ 优先级 70 | ✅ 单独 `# Memory` 区块（空模板会跳过） |
| `HEARTBEAT.md` | ✅ 动态注入 | ✅ Heartbeat 服务读取，不进 bootstrap |
| `IDENTITY.md` | ✅ 优先级 30（名字/emoji/头像） | ❌ 无此工作区文件 |
| `TOOLS.md` | ✅ 优先级 50 | ❌ 不注入（遗留文件可存在） |
| `BOOTSTRAP.md` | ✅ 首次引导用 | ❌ 无 |

## `IDENTITY.md` ≠ `templates/agent/identity.md`（易混淆）

| | OpenClaw `IDENTITY.md` | nanobot `templates/agent/identity.md` |
|---|------------------------|--------------------------------------|
| 位置 | 工作区根目录，用户可编辑 | 代码包内 Jinja 模板，**不**生成到工作区 |
| 含义 | AI「名片」：Name、Creature、Vibe、Emoji、Avatar | **运行时说明书**：OS/Python、工作区路径、通道排版、工具回复规则 |
| 谁的人设 | 用户与 agent 一起填写的身份档案 | 不是人设；人设在 **`SOUL.md`** |
| 展示名/图标 | 写入 `IDENTITY.md`，WebUI 读头像 | `config.json` 的 `botName` / `botIcon`（默认 `nanobot` / 🐈） |

### 对照关系

```text
OpenClaw IDENTITY.md  ≈  nanobot config botName/botIcon + SOUL 里固定自我介绍
OpenClaw SOUL.md      ≈  nanobot 工作区 SOUL.md
nanobot identity.md   ≈  OpenClaw 无直接对应（更像系统提示里的技术/工具段）
```

自定义「助手叫什么、什么气质」：改 **`~/.nanobot/workspace/SOUL.md`** 与配置里的 **`agents.defaults.botName` / `botIcon`**。

**下一步**：[记忆系统](./memory.md)
