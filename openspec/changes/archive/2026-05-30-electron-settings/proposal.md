## Why

Electron 统一收件箱（`electron-unified-inbox`）已完整交付，但设置管理仍需用户切换到 WebUI 操作。将 SettingsView 移植到 Electron 客户端，使用户在单一桌面应用内完成所有配置变更，消除上下文切换。前期已在 `electron-store` schema（`providers`/`models` 预留命名空间）和 IPC bridge（`config` 命名空间）中做好扩展准备。

## What Changes

- 移植 WebUI `SettingsView.tsx`（~4,674 行）内的 8 个 section 子面板到 Electron renderer
- 将 4,674 行单体文件拆分为独立子组件，提升可维护性（Electron 与 WebUI 共享）
- 对接 `/api/settings` 系列 HTTP 端点（Electron `api.ts` 已包含客户端函数）
- 激活侧边栏 Settings 齿轮图标，路由至设置视图
- 利用 `electron-store` 持久化 Electron 专属偏好（主题、语言等），替代 `localStorage`
- 主题切换从 localStorage 迁移到 `appearance.theme`（通过 IPC bridge 读写 electron-store）
- Models 页新增「辅助视觉模型」配置区块：暴露 `vision_model`/`vision_provider` 字段，并修复后端 schema 的 camelCase 解析缺失问题

## Capabilities

### New Capabilities
- `electron-settings-ui`: Electron 设置页 UI 层——拆分后的子面板组件、侧边栏路由、视图切换；包含 Models 页辅助视觉模型配置区块
- `electron-local-preferences`: Electron 本地偏好持久化——通过 IPC + electron-store 管理 theme、language、density 等客户端偏好，替代 localStorage

### Modified Capabilities

- **`vision-caption`**（后端）：为 `AgentDefaults.vision_model`/`vision_provider` 字段补充 camelCase `AliasChoices`（修复 config.json 解析缺失），并通过 `/api/settings` 端点暴露和写入这两个字段

## Impact

- **前端代码**：`electron/src/renderer/` 新增 settings 组件；`webui/src/components/settings/` 拆分重构（可选，若共享组件）
- **IPC 层**：`preload.ts` 可能扩展 `config` 命名空间方法（如 `config.getAll`）
- **electron-store**：`providers`/`models` 命名空间从预留变为使用（缓存层，不替代后端 config.json）
- **依赖**：无新外部依赖（已有 `electron-store`、`react-i18next`、`shadcn/ui`）
- **后端**：`settings_api.py` 扩展 `agent` 响应体和 `update_agent_settings()` 以支持 `vision_model`/`vision_provider`；`config/schema.py` 补充 camelCase 别名
