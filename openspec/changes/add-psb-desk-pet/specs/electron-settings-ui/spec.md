## MODIFIED Requirements

### Requirement: 设置视图渲染 8 个分区
Electron 渲染进程 SHALL 提供 SettingsLayout 组件，包含左侧导航栏和内容区域。导航栏 SHALL 包含恰好 9 个分区入口：概览、外观、模型、图像、网页、应用、运行时、桌宠、高级。

#### Scenario: 用户打开设置页
- **WHEN** 用户点击 InboxSidebar 中的设置齿轮图标
- **THEN** App 视图切换到 "settings"，SettingsLayout 渲染并默认激活「概览」分区

#### Scenario: 用户在分区间切换
- **WHEN** 用户点击设置导航中的某个分区
- **THEN** 内容区渲染对应的分区组件

## ADDED Requirements

### Requirement: 桌宠分区展示统一配置
Electron 设置页 SHALL 提供「桌宠」分区，用于展示统一 `deskPet` 配置。该分区 SHALL 包含 THA 子区和 PSB 子区，THA 子区读取 `deskPet.tha`，PSB 子区读取 `deskPet.psb`。

#### Scenario: 打开桌宠分区
- **WHEN** 用户在设置导航中点击「桌宠」
- **THEN** 内容区 SHALL 展示 THA 和 PSB 两个配置子区
- **AND** THA 子区 SHALL 展示现有 THA 开关、模型状态、窗口和音频延迟配置

#### Scenario: 保存 THA 配置
- **WHEN** 用户在 THA 子区修改配置并保存
- **THEN** 设置页 SHALL 调用统一桌宠设置更新接口写入 `deskPet.tha`
- **AND** 本变更不要求读取、迁移或提交旧顶层 `tha` 结构

### Requirement: PSB 设置 UI
Electron 设置页 SHALL 在桌宠分区提供 PSB 设置 UI，允许用户管理模型、选择当前模型、配置自动展示、鼠标追踪、特殊标签展示、初始状态和窗口行为。

#### Scenario: 展示 PSB 基础开关
- **WHEN** 桌宠分区加载完成
- **THEN** PSB 子区 SHALL 展示自动展示、当前选中模型、鼠标追踪、启用回复特殊标签、回复中展示特殊标签等配置项

#### Scenario: 选择当前模型
- **WHEN** 用户在 PSB 子区选择一个可用模型
- **THEN** 设置页 SHALL 保存 `deskPet.psb.selectedModelId`
- **AND** 初始状态配置项 SHALL 刷新为该模型的 timeline、expression、face 和 fade 能力

#### Scenario: 配置初始状态
- **WHEN** 用户打开 PSB 初始状态配置
- **THEN** 设置页 SHALL 使用当前模型已保存的中文元数据展示可选 timeline、表情、face 和 fade 项
- **AND** 初始 timeline 选择器 SHALL 只允许保存循环 timeline

#### Scenario: 展示模型解析错误
- **WHEN** 某个 PSB 模型元数据包含解析失败或翻译失败状态
- **THEN** 设置页 SHALL 在模型列表中展示对应状态和失败原因

### Requirement: PSB 模型说明
Electron 设置页 MAY 提示用户将 PSB 文件放入固定目录 `~/.nanobot/desk_pets/psb/` 并重启 gateway。第一版不提供设置页内扫描或上传入口。

#### Scenario: 展示已注册模型
- **WHEN** 用户打开 PSB 设置
- **THEN** 设置页 SHALL 通过服务端 API 展示已扫描注册的模型列表

#### Scenario: 模型翻译中
- **WHEN** 服务端在模型新增后正在翻译日文描述
- **THEN** 设置页 SHALL 显示翻译中状态
- **AND** 不阻塞用户关闭设置页

#### Scenario: 重试翻译
- **WHEN** 用户对翻译失败的模型点击重试翻译
- **THEN** 设置页 SHALL 调用服务端 API 请求重新翻译该模型元数据
- **AND** 翻译成功后 SHALL 展示中文文案

### Requirement: PSB 桌宠启动入口
Electron 设置页 SHALL 提供打开和关闭 PSB 桌宠的操作入口。

#### Scenario: 打开 PSB 桌宠
- **WHEN** 用户点击“打开 PSB 桌宠”
- **THEN** Electron SHALL 打开或聚焦 PSB 桌宠窗口

#### Scenario: 关闭 PSB 桌宠
- **WHEN** 用户点击“关闭 PSB 桌宠”
- **THEN** Electron SHALL 关闭当前 PSB 桌宠窗口
- **AND** 该操作 SHALL 不修改 `deskPet.psb.autoShow`
