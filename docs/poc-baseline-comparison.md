# 基底 POC 对比：nanobot vs NanoClaw vs Hermes Agent

> 目标：在 **4 小时内** 判断哪个更适合作为「类 OpenClaw AI 伴侣」的长期基底。  
> 关联设计：[electron-unified-inbox.md](./electron-unified-inbox.md)

## 本地仓库位置

| 项目 | 路径 | 远程 |
|------|------|------|
| **nanobot**（基准） | `/Users/illusion/dev/self/nanobot` | 你已有 |
| **NanoClaw** (Gavriel) | `/Users/illusion/dev/self/_poc-compare/nanoclaw-gavriel` | https://github.com/gavrielc/nanoclaw |
| **Hermes Agent** | `/Users/illusion/dev/self/_poc-compare/hermes-agent` | https://github.com/NousResearch/hermes-agent |

浅克隆（`--depth 1`），可长期保留供对照阅读；需要更新时在各自目录 `git pull --depth 1`。

---

## 初步扫描（2026-05-27，本地统计）

| 指标 | nanobot | NanoClaw | Hermes |
|------|--------:|---------:|-------:|
| 生产代码行数*（全仓口径） | **~7.5 万** | **~3.7 万** | **~54.6 万** |
| 测试代码行数 | ~8.2 万 | ~0.9 万 | ~47.1 万 |
| 主语言 | Python | TypeScript | Python |
| Agent 核心入口规模 | `agent/loop.py` **~1616 行** | `src/` **~140 个 .ts，合计 ~2 万行** | `agent/` + `gateway/` 等多模块 |

\*排除 `node_modules` 等；含注释与空行。

### 多口径补充（用于解释“核心看起来谁更小”）

| 口径 | nanobot | NanoClaw |
|------|--------:|---------:|
| 全仓生产代码 | ~74,752 | ~36,514 |
| 核心包/目录 | `nanobot/` ~54,135 | `src/` ~13,937 |
| Agent 主循环单文件 | `nanobot/agent/loop.py` **1,616** | （无单文件对等物，分散在 `router`/`session-manager`/`delivery`） |
| Electron 直接相关链路 | `loop`+`websocket`+`session`+`bus` ~4,793 | 需要跨 `src/` + `container/` + CLI socket |

说明：全仓口径下 NanoClaw 更小；但按你关心的「统一收件箱 + 主会话改造」链路，nanobot 的改动面更集中。

**最新结论（含静态审计，未做完整实跑）**：

- **Hermes**：伴侣能力叙事最强，但**代码体量接近/超过 OpenClaw 生产规模**，不符合「人能读」首要目标；优先作功能参考，**不建议换基底**。
- **NanoClaw**：`src/` 可审计，`agent-shared` 会话模型值得借鉴；但你要做的 Electron 统一收件箱需要额外桥接层，**预计 2–4 周**，显著高于 nanobot（2–3 天）。
- **nanobot**：你已具备 `unifiedSession` 与现成 WebSocket 通道，且改造点集中在 `websocket.py`/`loop.py`，**继续作为主基底最优**。

---

## NanoClaw：S1–S5 预估成本审计（静态）

| 标准 | 结论 | 预估成本 |
|------|------|----------|
| S1（2h 读通主链路） | ⚠️ 勉强：主机 + 容器双层路径 | 0.5–1 天 |
| S2（30min 跑通单通道） | ❌ 首次通常超时（Docker/凭证/通道接入） | 0.5–1 天 |
| S3（跨通道统一上下文） | ✅ 可通过 `agent-shared` 达成 | 2–4 小时 |
| S4（Electron 成本 ≤ nanobot 2x） | ❌ 明显超标 | 2–4 周 |
| S5（30min 小改动） | ⚠️ 文案类可，行为类常超时 | 0.5 小时–1 天 |

当前判断：**2/5 通过**（S3 稳定通过；S1/S5 勉强；S2/S4 不通过）。

---

## 个人项目的安全边界（务实版）

你的场景是「纯个人、非对外发布」，可以不追求 NanoClaw 那种重隔离，但建议保留**最低安全基线**：

- 仅绑定你自己的账号和群；不开公开群/公开 webhook。
- agent 运行在专用目录，避免挂载整个家目录。
- 模型/API 密钥分账号分用途，定期轮换。
- 对高风险工具（shell/写文件）保留确认开关或白名单目录。
- 关键会话和记忆目录做定期备份（最少每日）。

结论：在你的目标和约束下，**不需要为“企业级隔离”而换基底**，优先保证可维护性与迭代速度更划算。

---

## POC 成功标准（拍板用）

满足 **≥ 4/5** 条才考虑换基底；否则坚持 nanobot。

| # | 标准 | 权重 |
|---|------|------|
| S1 | **2 小时内**能画出「消息进 → 上下文组装 → LLM → 工具 → 出站」路径，并指出 3 个以内核心文件 | 必须 |
| S2 | **30 分钟内**跑通：安装 + 单通道收发包（Telegram 或 CLI 二选一） | 必须 |
| S3 | **跨通道统一上下文**：Telegram 说过的话，在第二入口（CLI/Web/另一通道）能续聊 | 必须 |
| S4 | 实现 [electron-unified-inbox](./electron-unified-inbox.md) Phase 2 的**预估增量** ≤ nanobot 方案（~200 行 / 2–3 天）的 **2 倍** | 高 |
| S5 | 改一处小行为（如欢迎语 / 系统提示一句）**< 30 分钟**且不踩未知全局状态 | 高 |

---

## Phase 0：环境准备（三项目通用，~30 min）

- [ ] 准备 1 个测试用 LLM API Key（OpenRouter / Anthropic / 你日常用的即可）
- [ ] 准备 1 个测试通道（推荐 **Telegram Bot** 或 **仅 CLI**，减少 OAuth）
- [ ] 记录机器环境：macOS / Docker 是否可用（NanoClaw **强依赖 Docker**）
- [ ] 开空白笔记，按下面模板记时间戳

---

## Phase 1：可读性审计（~60 min / 项目，nanobot 可跳过）

### 1.1 跟踪一条用户消息（必做）

在笔记里填：

```text
入站适配器: _______________
会话键规则: _______________
上下文/记忆注入: _______________
Agent 循环: _______________
工具执行: _______________
出站/推送: _______________
```

| 项目 | 建议起点文件 |
|------|----------------|
| **nanobot** | `nanobot/channels/base.py` → `nanobot/agent/loop.py` → `nanobot/session/` → `nanobot/providers/` |
| **NanoClaw** | `src/types.ts`（`session_mode`）→ `src/session-manager.ts` → `src/` 下 channel 适配 → `container/` |
| **Hermes** | `gateway/` → `agent/` → `hermes_cli/` |

**计时目标**：nanobot ≤30 min；NanoClaw ≤90 min；Hermes ≤120 min（若超时，Hermes 直接标 ❌ S1）。

### 1.2 可读性打分（1–5，5=最好）

| 维度 | nanobot | NanoClaw | Hermes |
|------|---------|----------|--------|
| 核心路径文件数 ≤10？ | | | |
| 单文件 <800 行（核心循环）？ | | | |
| 配置项是否可预测（<20 个关键 env）？ | | | |
| 有中文/清晰架构文档？ | | | |
| **小计 /20** | | | |

---

## Phase 2：跑通最小对话（~45 min / 项目）

### nanobot（基准，应已通过）

```bash
cd /Users/illusion/dev/self/nanobot
# 按你日常方式启动；至少验证：
# - unifiedSession: true
# - 一个通道 + CLI 或 WebSocket
```

- [ ] 发 3 轮对话，确认 session 文件落盘位置
- [ ] 记录启动命令与配置文件路径

### NanoClaw

```bash
cd /Users/illusion/dev/self/_poc-compare/nanoclaw-gavriel
bash nanoclaw.sh   # 或按 README Quick Start
```

- [ ] Docker 镜像构建成功
- [ ] 配对 **1 个通道**（建议 Telegram 或 CLI）
- [ ] 发 3 轮对话，确认容器内 agent 有响应
- [ ] 阅读 `docs/isolation-model.md`，试配置 **shared session**（跨通道共享记忆）
- [ ] 记录：是否必须 Anthropic/Claude Code（README 写原生 Claude Agent SDK）

### Hermes

```bash
cd /Users/illusion/dev/self/_poc-compare/hermes-agent
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
# 或按 README.zh-CN.md 用 venv
hermes setup
hermes gateway setup && hermes gateway start
```

- [ ] `hermes doctor` 无阻塞错误
- [ ] CLI `hermes` 对话 3 轮
- [ ] 网关 + **1 个**消息平台 3 轮
- [ ] 扫一眼 `hermes claw migrate` 文档（评估从 OpenClaw 迁移成本，非必须执行）

---

## Phase 3：伴侣关键能力（~90 min，对齐你的产品）

### 3.1 跨通道连续上下文（对应 S3）

| 检查项 | nanobot | NanoClaw | Hermes |
|--------|---------|----------|--------|
| 通道 A 发「我叫小明」 | `unifiedSession` + `unified:default` | `session_mode: shared` / 多通道单 session | Gateway 跨平台连续性 |
| 通道 B 问「我叫什么」 | | | |
| 是否开箱可用（无需大改）？ | 已有 | 读 `docs/isolation-model.md` | 查 gateway 会话模型 |

### 3.2 统一收件箱 / 桌面客户端（对应 S4）

对照 [electron-unified-inbox.md](./electron-unified-inbox.md) Phase 2：

| 能力 | nanobot 现状 | NanoClaw | Hermes |
|------|--------------|----------|--------|
| 稳定 `chat_id` / attach | WebSocket 需改 `websocket.py` | 查 WS/API 与 `session-manager` | gateway Web / API |
| 列出所有通道 session | 需放开 `sessions_list` 过滤 | SQLite `inbound.db` / routing | gateway 会话列表 |
| 统一 transcript 写入 | `loop.py` 出站 | 出站 DB + fan-out | 待查 |
| 实时 fan-out 到桌面 | `websocket.py` send | 待查 | `web/` 或 gateway 事件 |

- [ ] 每个项目写一句：**Electron 对接点**（协议：WS / HTTP / 无）
- [ ] 粗估改动行数：**___ 行 / ___ 天**

### 3.3 记忆与人格（伴侣感）

| 检查项 | nanobot | NanoClaw | Hermes |
|--------|---------|----------|--------|
| 工作区/人格文件 | `IDENTITY.md` / templates | per-agent `CLAUDE.md` | `/personality` |
| 长期记忆 | Dream / `memory.md` | per-agent workspace | FTS5 + memory 插件 |
| 主动提醒 | `cron` | scheduled tasks | `cron` + 自然语言调度 |
| 「越用越懂你」 | 中 | 低–中 | **高**（闭环学习） |

### 3.4 安全与信任（伴侣能执行命令时关键）

| 检查项 | nanobot | NanoClaw | Hermes |
|--------|---------|----------|--------|
| 工具/Shell 隔离 | Docker sandbox 等 | **容器级默认** | Docker/SSH/Modal 等 |
| 你能否接受其默认安全模型？ | | | |

---

## Phase 4：小改动实验（~30 min / 项目，验证 S5）

在同一行为上对比，例如：**首条回复加一句固定前缀 `[POC]`**。

| 项目 | 改动的文件 | 实际耗时 | 是否一次成功 |
|------|------------|----------|--------------|
| nanobot | `templates/AGENTS.md` 或 loop 内 system | | |
| NanoClaw | `CLAUDE.md` 或 agent 组配置 | | |
| Hermes | personality / system prompt 配置 | | |

---

## Phase 5：汇总打分表

### 权重（按你的目标「可读 + 伴侣 + Electron」）

| 维度 | 权重 |
|------|------|
| 可读可改 | 30% |
| 跨通道/统一会话 | 25% |
| Electron 收件箱落地成本 | 25% |
| 记忆/人格/主动能力 | 15% |
| 生态与长期维护 | 5% |

### 打分（1–5）

| 维度 | nanobot | NanoClaw | Hermes |
|------|---------|----------|--------|
| 可读可改 | | | |
| 跨通道/统一会话 | | | |
| Electron 收件箱 | | | |
| 记忆/人格 | | | |
| 生态维护 | | | |
| **加权总分** | | | |

### 决策

- [ ] **继续 nanobot**（默认）：总分最高或 NanoClaw/Hermes 未达 S1–S3
- [ ] **改基底 NanoClaw**：S1–S5 全过，且 Electron 成本 ≤2× nanobot
- [ ] **改基底 Hermes**：仅当「闭环学习」权重大幅上调且接受 50 万行级代码库
- [ ] **混合**：nanobot 基底 + 借鉴 Hermes 记忆 / NanoClaw 容器模型

---

## 建议排期（一个周末）

| 时段 | 内容 |
|------|------|
| 周六上午 | Phase 0–1：nanobot 复习 + NanoClaw 可读性 |
| 周六下午 | Phase 2–3：NanoClaw 跑通 + 跨通道测试 |
| 周日上午 | Phase 1–3：Hermes（若 S1 超时则只做 Phase 2 跑通） |
| 周日下午 | Phase 4–5：小改动 + 填打分表 |

---

## 参考链接

- [NanoClaw 文档](https://docs.nanoclaw.dev) · [隔离模型](https://github.com/gavrielc/nanoclaw/blob/main/docs/isolation-model.md)
- [Hermes 中文 README](https://github.com/NousResearch/hermes-agent/blob/main/README.zh-CN.md) · [文档站](https://hermes-agent.nousresearch.com/docs/)
- 本地对照：[nanobot-vs-openclaw-zh/](./nanobot-vs-openclaw-zh/README.md)

---

## POC 记录区（填写）

```text
日期:
执行人:

NanoClaw S1–S5:  ☐ 通过 / ☐ 未通过  备注:
Hermes  S1–S5:  ☐ 通过 / ☐ 未通过  备注:

最终决策:
```
