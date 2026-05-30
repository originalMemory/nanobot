## MODIFIED Requirements

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
