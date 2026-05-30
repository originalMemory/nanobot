## Context

Electron 统一收件箱已全功能交付（`electron-unified-inbox` 8 大模块全部 ✓）。当前 Electron 客户端侧边栏底部的 Settings 齿轮按钮为 disabled 占位，用户需切换到 WebUI 才能管理设置。

现有基础设施：
- **WebUI**：`SettingsView.tsx`（4,674 行单体文件，8 个 section 子面板全部内联）
- **Electron renderer**：已包含完整 settings API 客户端（`api.ts`）、`SettingsPayload` 类型、i18n 文案
- **Electron main**：`electron-store` schema 已预留 `providers`/`models` 命名空间；IPC bridge 已有 `config.get`/`config.set`
- **后端**：`/api/settings` 系列端点稳定运行

## Goals / Non-Goals

**Goals:**
- 在 Electron 客户端内提供完整设置管理能力（8 个 section）
- 将单体 `SettingsView.tsx` 拆分为模块化子组件（Electron 与 WebUI 可共享）
- Electron 本地偏好（theme、language、density 等）通过 `electron-store` + IPC 持久化，脱离 localStorage
- 设置变更后的 restart 提示体验与 WebUI 一致

**Non-Goals:**
- 不重写后端 settings API（复用现有端点）
- 不做 WebUI 与 Electron 的组件源码 monorepo 共享（本期各自维护副本，后续可抽取共享包）
- 不重构后端 GET-only API 为 RESTful POST/PUT

**注**：原定「不引入 Electron 独有的设置项」因实际需要做了一处例外——辅助视觉模型（`vision_model`/`vision_provider`）字段已存在于后端 schema 但 WebUI 未暴露，随本次一并在 Models 页加入配置入口，同时修复后端 camelCase 解析缺失。

## Decisions

### D1: 组件拆分策略——按 section 拆分为独立文件

**选择**：将 `SettingsView.tsx` 拆分为 `SettingsLayout.tsx`（壳 + nav）+ 每个 section 一个文件（`OverviewSection.tsx`、`AppearanceSection.tsx` 等）+ 共享 UI primitives（`SettingsRow.tsx`、`ProviderPicker.tsx`、`SegmentedControl.tsx`）。

**理由**：4,674 行单文件难以维护和复用。按 section 拆分后，Electron 可按需引入所需面板，且每个文件 ≤ 600 行，利于 code review。

**替代方案**：
- 整体移植不拆分：快但 Electron 维护成本高
- Monorepo shared package：收益高但引入构建复杂度，不适合当前项目规模

### D2: 本地偏好持久化层——electron-store via IPC

**选择**：Electron 中的 appearance/language/density 等客户端偏好写入 `electron-store`，通过已有 `electronAPI.config.get/set` IPC 读写。Renderer 用自定义 hook `useElectronPreference(key)` 封装。

**理由**：
- 已有 IPC 基础设施，无需新增通道
- electron-store 持久化到磁盘，跨窗口/重启生效
- WebUI 版仍走 localStorage（两者独立，行为一致）

**替代方案**：
- 继续用 localStorage：可行但 Electron 多窗口场景不同步
- 新建 preferences IPC 通道：过度设计，`config` 命名空间已足够

### D3: 路由方案——App 级 view state

**选择**：复用 `electron-unified-inbox` 已有的 `App.tsx` view 状态模式，新增 `view: "settings"` 分支，渲染 `SettingsLayout`。侧边栏 Settings 按钮切换 view。

**理由**：与 WebUI `App.tsx` 的 `ShellView = "chat" | "settings" | "apps"` 模式一致，无需引入 router 库。

### D4: electron-store providers/models 使用方式——缓存角色

**选择**：`providers`/`models` 命名空间仅用作 UI 渲染缓存（settings 页打开时从后端拉取写入 store，页面直接从 store 读取渲染）。真正的持久化仍由后端 `config.json` 完成。

**理由**：避免双写一致性问题。settings 变更仍通过 `/api/settings/update` 写回后端，electron-store 仅加速 UI 渲染和减少网络请求。

### D5: Restart 提示——WebSocket 通道

**选择**：settings 更新返回 `requires_restart: true` 时，渲染 restart banner。用户点击 restart 按钮通过 WebSocket 发送 `/restart` slash command（与 WebUI 行为一致）。

**理由**：复用现有重启机制，无需 Electron-specific 处理。

### D6: 辅助视觉模型——与主模型 Save 合并，provider 用下拉

**选择**：视觉模型（`vision_model`）用 Input，视觉服务商（`vision_provider`）用 ProviderPicker（含 Auto 选项，值为空字符串 = null = 按模型名自动检测）。两者与主模型区块共用同一个 Save 按钮，而非单独保存。

**理由**：
- `vision_provider` 和主模型 provider 共享同一批已配置 provider 列表，下拉选择比手填更可发现
- "Auto" 选项（空字符串 → 后端存为 `null`）语义清晰：主模型没有 "Auto"，因为主模型必须有明确 provider；视觉模型 provider 可选
- 与主模型合并保存减少操作步骤，两组字段同属 `update_agent_settings` 同一端点

**替代方案**：视觉模型独立 Save 按钮——可行但增加 UI 噪音，意义不大

## Risks / Trade-offs

- **[代码重复]** Electron 与 WebUI 各维护一份 settings 组件副本 → 后续可提取 `@nanobot/settings-ui` 共享包，本期接受重复以降低变更范围
- **[electron-store 与后端不同步]** 若用户同时在 WebUI 和 Electron 修改设置 → 每次打开 settings 页从后端拉取最新数据覆盖 store 缓存
- **[4,674 行拆分引入回归]** → 拆分后运行现有 `settings-view.test.tsx` 确保行为不变
- **[i18n key 一致性]** Electron locale 文件已从 WebUI 复制，需保持同步 → 后续可考虑构建时同步脚本
