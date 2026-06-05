# 上游合并指南（Upstream Merge Playbook）

本文档描述如何定期将上游 [HKUDS/nanobot](https://github.com/HKUDS/nanobot) 的更新合并到本 fork（`originalMemory/nanobot`）。

---

## 仓库拓扑

```
HKUDS/nanobot  (upstream)        originalMemory/nanobot  (origin)
     │                                    │
     │  main                              ├── main ← 上游同步分支
     │                                    └── lover ← 开发分支（fork 独有功能）
     ▼                                    ▼
  v0.2.0 ── v0.2.1 ── ...          main ← upstream/main
                                      │
                                   lover (Electron / Inbox / 主动陪伴 / 历史记忆 …)
```

| 分支     | 用途                                             |
| -------- | ------------------------------------------------ |
| `main`   | 跟踪上游 `upstream/main`；只通过 merge 推进      |
| `lover`  | 日常开发分支；包含所有 fork 独有功能；从 main 合并上游更新 |

---

## 一次性配置（首次操作）

```bash
# 添加上游 remote（每个本地仓库只需执行一次）
git remote add upstream https://github.com/HKUDS/nanobot.git

# 验证
git remote -v
# 应看到：
# origin    git@github.com:originalMemory/nanobot.git (fetch)
# upstream  https://github.com/HKUDS/nanobot.git (fetch)
```

---

## 定期合并流程

### 0. 前置检查

```bash
# 确保工作区干净
git stash  # 或 commit 未完成的工作

# 查看上游最新 release
open https://github.com/HKUDS/nanobot/releases
```

### 1. 拉取上游

```bash
git fetch upstream --tags
```

### 2. 更新本地 main

```bash
git checkout main
git merge upstream/main --ff-only
git push origin main
```

`--ff-only` 的作用：因为 `main` 从不产生本地提交，`upstream/main` 必然是 `main` 的直接后代，git 只需将分支指针前移——合并后 `main` 与上游完全相同，不会产生任何多余的 merge commit。`--ff-only` 同时起到安全卡的作用：万一 `main` 被意外写入了本地提交，命令会报错退出而不是静默合并，此时需要先排查再处理。

### 3. 合并到开发分支

```bash
git checkout lover
git merge main
# 弹出编辑器，建议在 message 中注明此次合并的上游版本，例如：
#   Merge upstream v0.2.1 into lover
```

此步骤会产生一个 merge commit，保留完整的合并历史。commit message 建议写明上游版本，方便以后通过 `git log --merges` 快速定位每次上游同步的节点。

### 4. 解决冲突

冲突通常集中在以下区域（按经验频率排序）：

| 高频冲突区                              | 原因                                 | 策略                                          |
| --------------------------------------- | ------------------------------------ | --------------------------------------------- |
| `pyproject.toml` (version)              | 上游 bump 版本号                     | 取上游版本号                                  |
| `README.md`                             | 双方都在更新 What's New              | 保留双方内容，fork 独有内容加 `<!-- fork -->` 注释 |
| `docker-compose.yml`                    | fork 有 Unraid 定制                  | 保留 fork 定制                                |
| `nanobot/config/schema.py`              | 双方都新增配置字段                   | 合并字段，检查 default 值                     |
| `nanobot/channels/websocket.py`         | 双方都改 WebSocket 协议              | 逐段对比，保留 fork 的 fan-out/presence 逻辑  |
| `nanobot/agent/loop.py`                 | agent 主循环改动                     | 最高优先级审查；保留 fork 的 unified session 逻辑 |
| `webui/` 下的组件                        | 上游 WebUI 更新，fork 有同源 electron 组件 | 合并后检查 electron 是否需要同步移植          |

冲突解决原则：

1. **版本号**：取上游值
2. **fork 独有模块**（`electron/`、`nanobot/proactive_chat/`、`nanobot/agent/historical_memory.py`）：保留 fork 版本
3. **上游新功能**：接受上游，检查是否与 fork 功能冲突
4. **同一函数双方都改**：读懂两边意图后手动合并；写测试覆盖
5. **上游删除的模块**：检查 fork 里是否还残留对已删模块的调用（如 `nanobot/heartbeat/`、`nanobot/heartbeat/service.py` 在 v0.2.1 已删）；若有，须一并清理，否则运行时会 NameError

```bash
# 列出所有冲突文件
git diff --name-only --diff-filter=U

# 逐个解决后标记
git add <resolved-file>

# 全部解决后提交
git commit  # 自动生成的 merge message 即可
```

### 5. 验证

```bash
# 后端测试
pytest tests/ -x -q

# WebUI 构建
cd webui && bun run build && cd ..

# Electron 构建（如改动涉及 electron/）
cd electron && npm run build && cd ..

# 类型检查
cd webui && bun run typecheck 2>/dev/null; cd ..
ruff check nanobot/
```

### 6. 推送

```bash
git push origin lover
```

---

## 合并后的跟进清单

合并完成后逐项检查：

- [ ] `pyproject.toml` 版本号与上游一致
- [ ] `docker-compose.yml` 的 fork 定制（Unraid uid/gid、note 挂载）未被覆盖
- [ ] 上游新增的配置项是否需要在 `electron/` 设置页同步支持
- [ ] 上游新增的 channel/provider 是否影响统一收件箱的 source badge 映射
- [ ] 上游 WebUI 新组件/改动是否需要移植到 `electron/src/renderer/`
- [ ] 上游新增/修改的 i18n key 是否需要在 `electron/` 侧的 `zh-CN/common.json` 同步
- [ ] `nanobot/agent/loop.py` 的改动是否影响 unified session / proactive chat 逻辑
- [ ] 历史记忆（`historical_memory.py`）的 `memory_search` 工具描述是否与上游 tool 注册方式兼容
- [ ] 上游安全修复是否已完整合入（搜索 `[security]` 标记的 PR）
- [ ] 测试通过

---

## Fork 独有模块清单

以下路径/功能为 fork 独有，合并时上游不会触碰，但需注意接口变化：

| 模块                               | 说明                          |
| ---------------------------------- | ----------------------------- |
| `nanobot/webui/fork_http.py`        | fork HTTP 路由（替代 upstream `ws_http.py` 的生产路径） |
| `electron/`                        | Electron 桌面客户端           |
| `nanobot/proactive_chat/`          | 主动陪伴服务                  |
| `nanobot/agent/historical_memory.py` | 外部日记库 FTS 检索         |
| `nanobot/agent/tools/tts.py`       | TTS 工具                      |
| `nanobot/providers/tts.py`         | TTS provider                  |
| `nanobot/skills/proactive-chat/`   | 主动陪伴编排 skill            |
| `openspec/`                        | OpenSpec 变更管理              |
| `specs/`                           | Spec-lite 规格                 |
| `docs/nanobot-vs-openclaw-zh/`     | 架构对比文档                  |
| `docs/electron-unified-inbox.md`   | 统一收件箱文档                |
| `docs/poc-baseline-comparison.md`  | POC 基底分析                  |

### 与 upstream 的有意差异

| 项目 | upstream | fork |
| ---- | -------- | ---- |
| HTTP handler | `ws_http.GatewayHTTPHandler` | `fork_http.ForkGatewayHTTPHandler`（生产路径） |
| `GET /api/workspaces` | 有，供 WebUI 工作区选择器 | **不实现** — 生产跑 Docker，容器已隔离文件系统，不需要 WebUI 工作区沙箱限制 |

---

## 版本号策略

| 场景               | 版本号处理                               |
| ------------------ | ---------------------------------------- |
| 纯上游 merge       | 取上游版本号                             |
| fork 独有功能发布  | 追加 `.forkN` 后缀，如 `0.2.1.fork1`    |
| Docker 镜像 tag    | 用 `latest` + 日期 tag（`20260605`）     |

---

## 快速参考命令

```bash
# 查看当前版本
grep '^version' pyproject.toml

# 查看上游最新 tag
git fetch upstream --tags && git tag -l 'v*' --sort=-v:refname | head -5

# 查看 fork 领先上游多少 commit
git rev-list --count upstream/main..lover

# 查看上游领先 fork 多少 commit（待合并量）
git rev-list --count lover..upstream/main

# 查看上游自某 tag 以来的 changelog
git log --oneline v0.2.1..upstream/main

# 查看合并预览（不实际合并）
git merge-tree $(git merge-base main upstream/main) main upstream/main | head -100

# 查看将产生冲突的文件
git checkout lover && git merge --no-commit --no-ff main && git diff --name-only --diff-filter=U; git merge --abort
```

---

## 历史合并记录

在每次合并后追加一行，详细冲突解决记录见 `docs/merges/` 文件夹。

| 日期       | 上游版本 | merge commit | 冲突数 | 详细记录                                              |
| ---------- | -------- | ------------ | ------ | ----------------------------------------------------- |
| 2026-06-05 | v0.2.1   | `e7240cad`   | 16     | [详情](merges/2026-06-05-upstream-v0.2.1.md)          |
