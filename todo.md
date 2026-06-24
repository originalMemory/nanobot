# 待改进项（TODO）

跟踪 PSB / gateway 等已知限制与后续优化，避免散落在代码注释里。完成一项后可删或移到 changelog。

---

## PSB / Gateway HTTP

### [ ] runtime-metadata 改用 POST body 或 WebSocket 一次性上报

**现状**

- Gateway 嵌入式 HTTP（`websockets` 库）**仅支持 GET**，不接受 request body（见 `websockets.http11.Request.parse`）。
- 单行 URL（含 query）默认上限约 **8KiB**（`WEBSOCKETS_MAX_LINE_LENGTH`）。
- PSB 同步 runtime 能力时 payload 较大（多 timeline、face/fade 变量），单条 GET 会 `ERR_EMPTY_RESPONSE` 或 500。

**临时方案（已实现）**

- 前端 `psb-runtime-metadata.js`：`splitCompactForServerSync()` 拆成多段 GET。
- 后端 `psb_store.merge_runtime_metadata()`：按字段分块、变量按 label 增量合并。
- `fork_http._run_async_json`：改为 `async/await`，避免在运行中的事件循环里 `run_until_complete`。
- runtime sync **不在 HTTP 请求内调用 LLM 翻译**（会阻塞数十秒导致超时）；标记 `translationStatus=pending`，设置页可「重试翻译」。

**目标**

- 新增 `POST /api/desk-pet/psb/models/{id}/runtime-metadata/update`（JSON body），或经已有 WebSocket 通道上报。
- 可能需要：独立 HTTP 服务、扩展 gateway HTTP 层、或 WS 多路复用新消息类型。
- 完成后可移除或简化分块 GET 逻辑。

**相关文件**

- `nanobot/webui/fork_http.py`
- `nanobot/webui/psb_api.py`
- `nanobot/web/psb/psb.js`
- `nanobot/web/psb/psb-runtime-metadata.js`

---

## PSB / 元数据与设置

### [ ] 「重扫」保留 runtime metadata

**现状**

- `rescan_model()` 调用 `_finalize_metadata()` 只读 PSB 文件头，会**清空** `timelines` / 变量列表，仅保留 `initialState`。
- 用户重扫后需重新打开 PSB 窗口才能再次 runtime sync。

**目标**

- 重扫时合并保留已有 runtime 字段，或提示「重扫后请重新打开桌宠以同步能力列表」。

**相关文件**

- `nanobot/webui/psb_store.py`（`rescan_model`、`_finalize_metadata`）

### [ ] Electron 设置页 timeline 下拉与 PSB 窗口行为对齐

**现状**

- PSB 配置面板：列出全部 timeline，非循环项标注「· 非循环」。
- Electron `PsbSection`：下拉只显示 `looping === true` 的项。

**目标**

- 统一展示（例如设置页也列出全部并标注），或明确文档说明二者差异。

**相关文件**

- `electron/src/renderer/components/settings/PsbSection.tsx`
- `nanobot/web/psb/psb-config-panel.js`

### [ ] 开发模式下 PSB 窗口自动打开 DevTools

**现状**

- 主窗口在 `electron-vite dev` 下自动 DevTools；PSB 无边框子窗口没有，调试需浏览器打开 `psb.html`。

**目标**

- 与主窗口一致，仅在 dev 时对 `psb-manager.ts` 创建的窗口调用 `openDevTools()`。

---

## Electron / 设置页（可选）

### [ ] CLI Apps 注册表拉取失败时降级

**现状**

- `/api/settings/cli-apps` 拉 GitHub registry 失败（代理/SSL）时可能 500，影响设置页。

**目标**

- 失败时返回空 catalog + 友好提示，不阻断设置页（可参考 `nanobot/apps/cli/service.py` 草稿修复）。

---

## 文档

- 运行时限制说明：`.agent/gotchas.md` → 「PSB Desk Pet / Gateway HTTP」
- 本文件：仓库根目录 `todo.md`
