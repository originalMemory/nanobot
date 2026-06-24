## ADDED Requirements

### Requirement: 桌宠偏好持久化到 electron-store
Electron 应用 SHALL 将客户端桌宠窗口偏好持久化到 `electron-store` 的 `deskPet` 命名空间。该命名空间 SHALL 仅保存 Electron 本地 UI 状态；PSB 模型列表、当前选中模型、模型元数据和初始状态 SHALL 以服务端 `deskPet` 配置和模型仓库为准。

#### Scenario: 首次启动桌宠默认值
- **WHEN** Electron 应用首次启动且 electron-store 中没有 `deskPet` 配置
- **THEN** store SHALL 使用默认桌宠窗口位置、尺寸、缩放和临时关闭状态
- **AND** 不得创建 Electron 本地 PSB 模型仓库作为权威来源

#### Scenario: 读取已有桌宠偏好
- **WHEN** Electron 应用启动且 electron-store 中存在 `deskPet` 配置
- **THEN** 应用 SHALL 读取并应用已保存的窗口位置、尺寸、缩放比例和临时关闭状态
- **AND** 模型选择和自动展示配置 SHALL 从服务端设置读取

### Requirement: PSB 本地缓存不得成为权威来源
Electron 应用 MAY 缓存 PSB 模型资源以提升加载速度，但 electron-store 中的缓存信息 MUST NOT 作为模型列表、当前选中模型、模型元数据或初始状态的权威来源。

#### Scenario: 使用服务端模型列表
- **WHEN** 用户打开 PSB 设置页
- **THEN** Electron SHALL 从服务端模型 API 获取模型列表和元数据
- **AND** 不得仅依赖 electron-store 中的缓存渲染权威模型列表

#### Scenario: 保存当前选中模型到服务端
- **WHEN** 用户选择一个 PSB 模型作为当前模型
- **THEN** Electron SHALL 调用服务端设置 API 保存 `deskPet.psb.selectedModelId`

#### Scenario: 保存模型初始状态到服务端
- **WHEN** 用户保存某个 PSB 模型的初始状态
- **THEN** Electron SHALL 调用服务端模型 API 保存初始 timeline、expression、face 和 fade 配置

### Requirement: PSB 自动展示和关闭状态处理
Electron 应用 SHALL 区分服务端 PSB 自动展示配置、Electron 本地临时关闭状态和永久关闭动作。临时关闭 SHALL 不改变 `autoShow`，永久关闭 SHALL 修改服务端 `autoShow`。

#### Scenario: 临时关闭状态不持久化为禁用
- **WHEN** 用户点击 PSB 桌宠的临时关闭按钮
- **THEN** Electron SHALL 关闭窗口
- **AND** `deskPet.psb.autoShow` SHALL 保持原值

#### Scenario: 永久关闭写入偏好
- **WHEN** 用户点击 PSB 桌宠的永久关闭按钮
- **THEN** Electron SHALL 调用服务端设置 API 将 `deskPet.psb.autoShow` 设置为 false

#### Scenario: 重启后自动展示
- **WHEN** 应用重启且服务端 `deskPet.psb.autoShow` 为 true
- **THEN** Electron SHALL 在模型可用时自动打开 PSB 桌宠窗口

### Requirement: PSB 窗口状态持久化
Electron 应用 SHALL 持久化 PSB 桌宠窗口的位置、尺寸、缩放比例和鼠标追踪状态。

#### Scenario: 拖拽后保存位置
- **WHEN** 用户拖拽 PSB 桌宠窗口到新位置
- **THEN** Electron SHALL 保存窗口位置
- **AND** 下次打开 PSB 窗口时 SHALL 使用上次位置

#### Scenario: 缩放后保存比例
- **WHEN** 用户通过控制列调整 PSB 模型缩放
- **THEN** Electron SHALL 保存缩放比例
- **AND** 下次打开 PSB 窗口时 SHALL 使用该比例

#### Scenario: 保存鼠标追踪开关
- **WHEN** 用户开启或关闭 PSB 鼠标追踪
- **THEN** Electron SHALL 调用服务端设置 API 将状态保存到 `deskPet.psb.followMouse`
