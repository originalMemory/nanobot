## ADDED Requirements

### Requirement: 主题偏好持久化到 electron-store
Electron 应用 SHALL 将用户的主题偏好持久化到 `electron-store` 的 `appearance.theme` 键下。主题值 SHALL 为以下 9 个字符串之一：`"light"` | `"dark"` | `"midnight"` | `"desert"` | `"neon"` | `"marshmallow"` | `"ink"` | `"party"` | `"rainbow"`。主题变更 SHALL 通过 `electronAPI.config.set("appearance.theme", value)` 写入，并在启动时通过 `electronAPI.config.get("appearance.theme")` 读取。

#### Scenario: 主题变更在重启后保持
- **WHEN** 用户将主题切换为 "midnight"
- **THEN** `appearance.theme` 在 electron-store 中被设置为 `"midnight"`
- **AND** 下次应用启动时，无需用户操作即以 midnight 主题渲染

#### Scenario: 主题在设置页和侧边栏间同步
- **WHEN** 用户在「外观」分区中更改主题
- **THEN** InboxSidebar 的主题切换按钮立即反映新状态

#### Scenario: 旧版 "light"/"dark" 值向前兼容
- **WHEN** electron-store 中存在旧版本写入的 `appearance.theme: "dark"` 值
- **THEN** 应用正常以 dark 主题启动
- **AND** 不产生错误或异常

#### Scenario: 无效主题值 fallback
- **WHEN** electron-store 中 `appearance.theme` 为无效值（如 `"unknown"`）
- **THEN** 应用 SHALL fallback 到 `"light"` 主题
- **AND** 将有效值 `"light"` 写回 store

### Requirement: 语言偏好持久化到 electron-store
Electron 应用 SHALL 将用户的语言偏好持久化到 `electron-store` 的 `appearance.language` 键下。`LanguageSwitcher` 组件 SHALL 通过 IPC 写入选中的语言。

#### Scenario: 语言变更持久化
- **WHEN** 用户在「外观」分区中选择不同语言
- **THEN** `appearance.language` 被写入 electron-store
- **AND** 下次应用启动时，`i18next` 以存储的语言初始化

### Requirement: 本地 UI 偏好持久化到 electron-store
客户端偏好（界面密度、活动详情模式、代码换行、品牌 Logo）SHALL 存储在 electron-store 的 `appearance.preferences` 下，替代 WebUI 的 localStorage 方案。

#### Scenario: 界面密度偏好持久化
- **WHEN** 用户将界面密度从「舒适」切换为「紧凑」
- **THEN** `appearance.preferences.density` 在 electron-store 中被设置为 `"compact"`
- **AND** UI 立即反映紧凑密度

#### Scenario: 偏好在应用重装后数据迁移中存活
- **WHEN** 存在来自旧版本的 electron-store 数据文件
- **THEN** 应用读取并应用所有已存储的偏好，不产生错误

### Requirement: useElectronPreference hook 封装 IPC
`useElectronPreference<T>(key, defaultValue)` hook SHALL 为 electron-store 键提供响应式的 get/set 能力。它 SHALL：
1. 在挂载时从 electron-store 读取初始值
2. 返回 `[value, setValue]` 元组
3. 在 setValue 时调用 `electronAPI.config.set(key, newValue)`
4. 立即（乐观地）更新本地状态

#### Scenario: Hook 读取初始值
- **WHEN** 组件以 `useElectronPreference("appearance.theme", "light")` 挂载
- **THEN** hook 返回 electron-store 中存储的值（若未设置则返回默认值）

#### Scenario: Hook 写入值
- **WHEN** 调用 `setValue("dark")`
- **THEN** 本地状态立即更新为 `"dark"`
- **AND** `electronAPI.config.set("appearance.theme", "dark")` 被调用

### Requirement: electron-store schema 扩展以支持偏好
`AppConfig` 接口和 store 默认值 SHALL 包含：
- `appearance.language: string`（默认：`"en"`）
- `appearance.preferences: { density, activityMode, codeWrap, brandLogos }`，各字段具有合理默认值

#### Scenario: 首次安装使用默认值
- **WHEN** Electron 应用首次启动（无已有 store 文件）
- **THEN** `appearance.language` 为 `"en"`，`appearance.preferences.density` 为 `"comfortable"`
