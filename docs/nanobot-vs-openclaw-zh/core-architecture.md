# 核心架构对比

[← 目录](./README.md)

## 数据流：消息如何穿过系统

### nanobot：双队列消息总线

```
[Channel] --InboundMessage--> MessageBus.inbound
                                    |
                              AgentLoop（编排）
                                    |
                              AgentRunner（LLM 多轮 + 工具）
                                    |
[Channel] <--OutboundMessage-- MessageBus.outbound
```

- **MessageBus**（`nanobot/bus/queue.py`）：两个 `asyncio.Queue`，解耦通道与 Agent 核心。
- **AgentLoop**（`nanobot/agent/loop.py`）：会话键、Hook、上下文构建、记忆整合、命令路由、子 Agent。
- **AgentRunner**（`nanobot/agent/runner.py`）：向 Provider 发消息、处理 tool call、流式输出。

设计约束（`.agent/design.md`）明确要求：**少改 loop/runner**，新能力优先放在 `channels/`、`tools/`、Skill 或 MCP。

### OpenClaw：Gateway 中心化控制平面

```
[Channel 连接] ──► Gateway（单例守护进程）
                      ├── WebSocket API（CLI / WebUI / Node）
                      ├── 通道会话（如 WhatsApp 仅 Gateway 持有一个）
                      ├── agent / chat / cron / presence 事件
                      └── HTTP（Canvas、A2UI 等）

[Client] <--WS req/res + events--> Gateway <--► Agent 运行时
[Node 设备] --role:node--> Gateway（camera、canvas、screen 等能力）
```

- 默认绑定 `127.0.0.1:18789`（可配置）。
- 协议：JSON over WebSocket，首帧必须 `connect`，支持幂等键、设备配对、Tailscale 等认证模式。
- **一台主机一个 Gateway**；WhatsApp 等会话由 Gateway 独占。

### 对比要点

| 方面 | nanobot | OpenClaw |
|------|---------|----------|
| 中枢抽象 | 内存消息总线 + Python 进程 | 长驻 Gateway 守护进程 + WS 协议 |
| 客户端模型 | WebUI、CLI、OpenAI API、各 Channel | 同上 + macOS/iOS/Android App + Node |
| 协议标准化 | WebUI 复用 WS；对外有 OpenAI 兼容 API | 完整 Gateway Protocol（JSON Schema + codegen） |
| 扩展边界 | pkgutil 扫描 + entry-point 插件 | manifest 能力模型 + `extensions/` + plugin-sdk |

## Agent 循环

| 组件 | nanobot | OpenClaw |
|------|---------|----------|
| 编排层 | `AgentLoop` + `TurnState` 状态机 | `src/agents/` + `auto-reply/` 等 |
| 执行层 | `AgentRunner` + `AgentRunSpec` | Provider 插件 + 通用推理循环 |
| 工具 | `nanobot/agent/tools/*`，registry 自动发现 | `src/tools/` + 插件注册工具 |
| 子 Agent | `SubagentManager` / `spawn` 工具 | 子 Agent / 线程隔离上下文 |
| 记忆 | `Dream` 两阶段整合 + `Consolidator` | `memory/` + 多种 memory 插件（如 lancedb） |
| 上下文压缩 | `AutoCompact`、SessionManager | `context-engine/`、session 管线 |
| 长期目标 | `/goal`、`long_task`、sustained goal state | `commitments/` 等（产品演进中） |

nanobot 将「循环」集中在两个 Python 文件中，便于阅读与贡献；OpenClaw 将 Agent 能力拆散到多个模块，并通过插件注册 Provider/Tool/Media 等能力。

**下一步**：[子系统对照](./subsystems.md) · [架构图](./diagrams.md)
