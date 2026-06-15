# Spec: electron-workspace-viewer

## Why
- Electron 客户端只能聊天/设置，无法浏览 nanobot 工作区里的 `MEMORY.md`、配置、脚本等文件。
- 工作区文件以 `.md` 为主，其次是 `.json`/`.py`/`.sh`；只需只读预览，不需编辑。
- **Electron 与 gateway 常不在同一台机器**：`settings.runtime.workspace_path` 是**服务端**路径，Electron 主进程读本地盘拿不到远端文件。
- **现状**：gateway 仅有 `/api/workspaces`（scope 元数据）和 settings 里的路径字符串，**没有** list/read 文件内容 API；必须新增后端只读接口。
- 现有 `MarkdownTextRenderer` + `CodeBlock` 已覆盖渲染；缺 gateway API + 前端浏览 UI。

## Scope
- 本次要做：gateway 新增只读 HTTP API（见 Apply Notes），在 **gateway 进程所在机器**读 workspace 文件。
- 本次要做：Electron renderer 用 Bearer token 调 gateway API（与 `fetchSettings` 同模式），**不用** main process `fs` IPC。
- 本次要做：Electron 侧栏「工作区」入口，只读浏览视图（树 + 预览）。
- 本次要做：路径校验——相对路径解析后必须落在 workspace root 内；复用 agent `ListDirTool._IGNORE_DIRS` 过滤噪声目录。
- 本次要做：按扩展名路由预览——`.md` → 轻量 MD；`.json`/`.py`/`.sh` 等 → `CodeBlock`；JSON 先 format，失败原样高亮。
- 本次要做：大文件/二进制/不支持类型友好提示；中英文 i18n；后端 + 前端单测。
- 本次不做：webui 浏览器版（API 设计通用，UI 仅 Electron）；文件编辑/保存；Monaco；全文搜索；git diff。
- 本次不做：PDF/图片内嵌预览；按 session 切换 project（V1 固定 gateway 默认 `workspace_path`）。

## Plan
- [x] 后端 `nanobot/webui/workspace_files.py`：共享 `list_dir` / `read_file` 逻辑（路径 resolve、ignore dirs、10MB 截断/上限、二进制检测）；与 agent 工具行为对齐。
- [x] `fork_http.py`：`GET /api/workspace/list?path=`、`GET /api/workspace/read?path=`，Bearer 鉴权；`path` 为相对 workspace root 的路径（空=根）。
- [x] ~~`ws_http.py`~~：不改动，减少与上游合并冲突；路由仅注册在 `fork_http.py`。
- [x] `tests/webui/test_workspace_files_api.py`：list/read 正常、ignore dirs、`../` 拒绝、超大截断、二进制拒绝。
- [x] `electron/lib/api.ts`：`fetchWorkspaceList` / `fetchWorkspaceRead`。
- [x] `electron/lib/workspaceViewer.ts`：扩展名 → 预览模式映射。
- [x] `electron/components/workspace/WorkspaceView.tsx` + `FilePreview.tsx`：左树右预览；lazy 展开调 list API。
- [x] `App.tsx`：`view` 加 `"workspace"`；`InboxSidebar` 加入口；进入时用 `fetchSettings` 显示 root 路径标签。
- [x] i18n + electron 前端单测。

## Apply Notes

### 部署与数据流
```text
Electron (任意机器)  --HTTP Bearer-->  Gateway (workspace 所在机器)
                                         └─ fs.read / fs.readdir
```
- 同机部署只是 API 的自然结果，**不设**「本地 IPC 快路径」分支。
- workspace root = gateway `config.workspace_path`（与 `settings.runtime.workspace_path` 一致）。

### Gateway API（仅 GET，兼容 websockets HTTP 解析器）
| 路由 | 参数 | 响应 |
|------|------|------|
| `GET /api/workspace/list` | `path`（可选，相对路径） | `{ path, entries: [{name, kind:"file"\|"dir"}], truncated? }` |
| `GET /api/workspace/read` | `path`（必填，相对路径） | `{ path, content, truncated?, size_bytes?, encoding:"utf-8" }` 或 4xx |

- 鉴权：`check_api_token`，与 `/api/settings` 相同。
- 路径：拒绝 `..`、绝对路径、symlink 逃逸；resolve 后 `relative_to(workspace_root)`。
- list：单层非 recursive；ignore dirs 同 agent。
- read：UTF-8 文本；图片（png/jpg/gif/webp/bmp/ico，不含 svg）返回 `kind=image` + `content_base64` + `mime_type`，不写 media 目录；含 NUL 或其它二进制扩展名 → 415；文本超 10MB 截断；图片超 10MB → 413。
- 逻辑抽到 `workspace_files.py`，仅 `fork_http` 注册路由（`ws_http` 不改，减合并冲突）。

### Electron 前端
- 不调 `electronAPI` / main process 读盘；`preload` 无需新增 workspace IPC。
- 目录树 lazy load：展开目录时 `fetchWorkspaceList(token, base, relPath)`。
- MD 轻量：`WorkspaceMarkdown` 仅 `remark-gfm` + `react-markdown`，不加载 KaTeX。
- 代码高亮：复用 `CodeBlock` lazy prism。
- 不新增 npm 依赖。

## Verify
- [x] **远程场景**：gateway 跑在 A 机，Electron 连 A 的 URL，能 list/read A 上 workspace 文件（非 Electron 本机路径）。
- [x] 侧栏「工作区」↔ 收件箱切换正常。
- [x] 树展示 root 下条目；`.git`、`node_modules` 不出现。
- [x] `memory/MEMORY.md` GFM 渲染正常。
- [x] `.json` 格式化 + 高亮；`.py`/`.sh` 高亮。
- [x] 二进制或 >10MB：API 拒绝或 truncated；UI 提示，不白屏。
- [x] API 传 `path=../etc/passwd`：403/400。
- [x] `pytest tests/webui/test_workspace_files_api.py` + electron 相关测试通过。

## Status
- State: done
- Archived: yes
