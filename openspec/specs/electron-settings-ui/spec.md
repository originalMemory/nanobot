## Purpose

Electron 设置页 UI：分区导航、模型与桌宠等配置入口。
## Requirements
### Requirement: 设置视图渲染 8 个分区
Electron 渲染进程 SHALL 提供 SettingsLayout 组件，包含左侧导航栏和内容区域。导航栏 SHALL 包含恰好 9 个分区入口：概览、外观、模型、图像、网页、应用、运行时、桌宠、高级。

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
模型分区 SHALL 允许用户选择模型预设、配置 BYOK 提供商（API key、base URL）、创建新的模型配置，**并编辑生成与上下文参数（maxTokens、contextWindowTokens、maxMessages）**。

#### Scenario: 选择模型预设
- **WHEN** 用户从选择器中选择不同的模型预设
- **THEN** 系统调用 `/api/settings/update?model_preset=<slug>` 并刷新显示的模型信息

#### Scenario: 配置提供商 API key
- **WHEN** 用户为某提供商输入 API key 并保存
- **THEN** 系统调用 `/api/settings/provider/update?provider=<name>&api_key=<value>` 并更新提供商状态指示器

#### Scenario: 创建模型配置
- **WHEN** 用户填写标签、模型名称、提供商后点击保存
- **THEN** 系统调用 `/api/settings/model-configurations/create` 传入对应参数，新预设出现在选择器中

#### Scenario: 编辑 maxTokens
- **WHEN** 用户在「Generation & Context」分组中修改 Max Output Tokens 输入框的值并保存
- **THEN** 系统调用 `/api/settings/update?max_tokens=<value>`，值 SHALL 为正整数

#### Scenario: 编辑 contextWindowTokens
- **WHEN** 用户在「Generation & Context」分组中修改 Context Window 输入框的值并保存
- **THEN** 系统调用 `/api/settings/update?context_window_tokens=<value>`，值 SHALL ≥ 4096

#### Scenario: 编辑 maxMessages
- **WHEN** 用户在「Generation & Context」分组中修改 Max Messages 输入框的值并保存
- **THEN** 系统调用 `/api/settings/update?max_messages=<value>`，值 SHALL ≥ 0（0 表示使用默认 120）

#### Scenario: 值回显
- **WHEN** 设置页加载完成
- **THEN** maxTokens、contextWindowTokens、maxMessages 三个字段 SHALL 显示 `/api/settings` 返回的当前值

#### Scenario: 无效值校验
- **WHEN** 用户输入非数字或超出范围的值
- **THEN** 保存按钮 SHALL 保持禁用或显示校验提示

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
Electron 设置页 SHALL 在桌宠分区提供 PSB 设置 UI，允许用户管理模型、选择当前模型、配置自动展示、鼠标追踪、特殊标签展示和窗口行为。初始 timeline / 表情 / Face / Fade 初始状态 SHALL 在 PSB 桌宠窗口配置面板中设置并保存。

#### Scenario: 展示 PSB 基础开关
- **WHEN** 桌宠分区加载完成
- **THEN** PSB 子区 SHALL 展示自动展示、当前选中模型、鼠标追踪、启用回复特殊标签、回复中展示特殊标签等配置项

#### Scenario: 选择当前模型
- **WHEN** 用户在 PSB 子区选择一个可用模型
- **THEN** 设置页 SHALL 保存 `deskPet.psb.selectedModelId`
- **AND** PSB 桌宠窗口配置面板 SHALL 可读取该模型的 timeline、expression、face 和 fade 能力

#### Scenario: 配置初始状态
- **WHEN** 用户在 PSB 桌宠窗口打开配置面板
- **THEN** 用户 SHALL 可在面板中选择循环 timeline、表情、face 和 fade 初始值并保存到服务端
- **AND** 初始 timeline 选择器 SHALL 只允许保存循环 timeline

#### Scenario: 展示模型解析错误
- **WHEN** 某个 PSB 模型元数据包含解析失败或翻译失败状态
- **THEN** 设置页 SHALL 在模型列表中展示对应状态和失败原因

### Requirement: PSB 模型说明
Electron 设置页 SHALL 提示用户将 PSB 文件放入固定目录 `~/.nanobot/desk_pets/psb/` 并重启 gateway。第一版 SHALL 不提供设置页内扫描或上传入口。

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

