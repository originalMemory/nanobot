## ADDED Requirements

### Requirement: 设置视图渲染 8 个分区
Electron 渲染进程 SHALL 提供 SettingsLayout 组件，包含左侧导航栏和内容区域。导航栏 SHALL 包含恰好 8 个分区入口：概览、外观、模型、图像、网页、应用、运行时、高级。

#### Scenario: 用户打开设置页
- **WHEN** 用户点击 InboxSidebar 中的设置齿轮图标
- **THEN** App 视图切换到 "settings"，SettingsLayout 渲染并默认激活「概览」分区

#### Scenario: 用户在分区间切换
- **WHEN** 用户点击设置导航中的某个分区
- **THEN** 内容区渲染对应的分区组件

### Requirement: 侧边栏设置按钮可用
InboxSidebar 中的设置按钮 SHALL 处于启用状态且可点击，点击后 SHALL 触发从收件箱到设置的视图切换。

#### Scenario: 设置按钮触发视图切换
- **WHEN** 用户点击 InboxSidebar 中的「设置」导航项
- **THEN** `onOpenSettings` 回调被调用，App 渲染 SettingsLayout

#### Scenario: 返回导航回到收件箱
- **WHEN** 用户点击 SettingsLayout 头部的返回/关闭按钮
- **THEN** App 视图切换回收件箱

### Requirement: 概览分区展示系统摘要
概览分区 SHALL 展示当前 AI 模型、已配置能力（网页搜索、图像生成、应用）以及系统信息（gateway URL、工作区路径）的卡片摘要。

#### Scenario: 概览显示当前模型
- **WHEN** 从 `/api/settings` 加载设置数据
- **THEN** 概览显示当前激活的模型预设名称或模型/提供商组合

#### Scenario: 概览能力卡片链接到对应分区
- **WHEN** 用户点击某个能力卡片（如「网页搜索」）
- **THEN** 导航切换到对应分区（如 "web"）

### Requirement: 模型分区管理模型和提供商配置
模型分区 SHALL 允许用户选择模型预设、配置 BYOK 提供商（API key、base URL），以及创建新的模型配置。

#### Scenario: 选择模型预设
- **WHEN** 用户从选择器中选择不同的模型预设
- **THEN** 系统调用 `/api/settings/update?model_preset=<slug>` 并刷新显示的模型信息

#### Scenario: 配置提供商 API key
- **WHEN** 用户为某提供商输入 API key 并保存
- **THEN** 系统调用 `/api/settings/provider/update?provider=<name>&api_key=<value>` 并更新提供商状态指示器

#### Scenario: 创建模型配置
- **WHEN** 用户填写标签、模型名称、提供商后点击保存
- **THEN** 系统调用 `/api/settings/model-configurations/create` 传入对应参数，新预设出现在选择器中

### Requirement: 模型分区暴露辅助视觉模型配置
模型分区 SHALL 在主模型组下方展示「视觉模型」组，包含模型名称输入框和提供商选择器（含「自动」选项，表示 null/自动检测）。这两个字段 SHALL 与主模型通过同一次 `/api/settings/update` 调用一起保存。

#### Scenario: 配置视觉模型
- **WHEN** 用户输入模型名称（如 `gemini-2.5-flash`）并选择提供商后点击保存
- **THEN** 系统调用 `/api/settings/update?vision_model=<model>&vision_provider=<provider>`，输入框反映已保存的值

#### Scenario: 清除视觉模型
- **WHEN** 用户清空视觉模型输入框并点击保存
- **THEN** 系统调用 `/api/settings/update?vision_model=`（空字符串），后端存储 `null`，禁用图像描述功能

#### Scenario: 自动检测视觉提供商
- **WHEN** 用户在视觉提供商选择器中选择「自动」（值为 ""）
- **THEN** `vision_provider` 以空字符串发送，后端存储 `null`，运行时从模型名称推断提供商

### Requirement: 图像生成分区管理图像设置
图像分区 SHALL 允许切换图像生成开关、选择提供商/模型，以及配置默认值（宽高比、尺寸）。

#### Scenario: 切换图像生成
- **WHEN** 用户切换图像生成开关
- **THEN** 系统调用 `/api/settings/image-generation/update?enabled=<bool>`

#### Scenario: 保存图像默认值
- **WHEN** 用户更改宽高比或模型后点击保存
- **THEN** 系统通过图像生成更新端点持久化变更

### Requirement: 网页分区管理网页搜索配置
网页分区 SHALL 允许选择搜索提供商、输入 API 凭证，以及配置行为（最大结果数、超时、Jina reader）。

#### Scenario: 更新网页搜索提供商
- **WHEN** 用户选择不同的网页搜索提供商
- **THEN** 系统调用 `/api/settings/web-search/update` 传入新提供商值

### Requirement: 应用分区展示 CLI 应用和 MCP 预设
应用分区 SHALL 展示 CLI 应用和 MCP 服务器预设的目录。用户 SHALL 能够安装/卸载 CLI 应用，以及启用/移除 MCP 预设。

#### Scenario: 安装 CLI 应用
- **WHEN** 用户点击 CLI 应用卡片上的「安装」
- **THEN** 系统调用 `/api/settings/cli-apps/install?name=<app>` 并显示进度

#### Scenario: 启用 MCP 预设
- **WHEN** 用户点击 MCP 预设上的「启用」
- **THEN** 系统调用 `/api/settings/mcp-presets/enable?name=<preset>` 并更新状态

#### Scenario: 添加自定义 MCP 服务器
- **WHEN** 用户填写自定义 MCP 服务器表单并提交
- **THEN** 系统调用 `/api/settings/mcp-presets/custom` 传入服务器配置

### Requirement: 运行时分区展示身份和系统信息
运行时分区 SHALL 允许编辑机器人名称、机器人图标和时区。系统信息（配置路径、工作区、gateway、心跳）SHALL 以只读方式展示。

#### Scenario: 更新机器人身份
- **WHEN** 用户修改 bot_name 并保存
- **THEN** 系统调用 `/api/settings/update?bot_name=<value>`

### Requirement: 高级分区为只读
高级分区 SHALL 以只读信息形式展示安全设置、集成数量和执行配置。

#### Scenario: 查看高级设置
- **WHEN** 用户导航到高级分区
- **THEN** 所有字段渲染为只读标签，不带编辑控件

### Requirement: 配置变更后显示重启提示横幅
当设置更新响应包含 `requires_restart: true` 时，设置视图顶部 SHALL 显示重启提示横幅。点击重启按钮 SHALL 通过当前活动的 WebSocket 连接发送 `/restart`。

#### Scenario: 提供商变更后需要重启
- **WHEN** 用户更新提供商 API key，响应包含 `requires_restart: true`
- **THEN** 横幅出现，提示「需要重启以使变更生效」并提供重启按钮

#### Scenario: 用户触发重启
- **WHEN** 用户点击横幅中的「重启」按钮
- **THEN** 通过 WebSocket 通道发送 `/restart` 斜杠命令
