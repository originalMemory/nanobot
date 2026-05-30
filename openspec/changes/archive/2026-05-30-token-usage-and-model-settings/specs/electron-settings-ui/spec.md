## MODIFIED Requirements

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
