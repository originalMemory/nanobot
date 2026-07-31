## ADDED Requirements

### Requirement: 侧边栏直接进入 Automation
Electron SHALL 在主侧边栏提供 Automation 按钮，并直接切换到任务管理页面而不经过设置页。

#### Scenario: 打开任务管理页
- **WHEN** 用户点击侧边栏的 Automation 按钮
- **THEN** 主区域显示 Automation 页面，按钮显示当前激活状态
- **AND** 聊天页面保持挂载，返回后不重新加载消息历史

### Requirement: 查看现有 Cron 任务
系统 SHALL 展示 Gateway 当前 `CronService` 中的全部任务，包括已禁用任务。

#### Scenario: 加载任务列表
- **WHEN** 已认证的 Electron 客户端打开 Automation 页面
- **THEN** 页面展示任务名称、启用状态、运行状态、调度方式、下次运行时间、最近结果和投递目标

#### Scenario: 无任务
- **WHEN** Cron 服务中没有任务
- **THEN** 页面展示明确的空状态而不是错误或空白页

### Requirement: 管理普通任务
系统 SHALL 允许用户暂停、恢复、立即运行和删除普通 `agent_turn` 任务。

#### Scenario: 暂停或恢复任务
- **WHEN** 用户对普通任务执行暂停或恢复
- **THEN** Gateway 通过当前运行中的 `CronService` 更新任务
- **AND** 页面刷新为服务端返回的最新状态

#### Scenario: 立即运行任务
- **WHEN** 用户点击普通任务的立即运行按钮
- **THEN** Gateway 在后台启动该任务并立即响应，不等待模型调用完成
- **AND** 页面轮询并显示该任务正在运行，完成后展示最新运行结果

#### Scenario: 防止重复运行
- **WHEN** 同一任务已由定时器或手动操作触发且仍在运行
- **THEN** Gateway 不再启动第二次执行并返回该任务仍在运行

#### Scenario: 运行期间刷新列表
- **WHEN** 任务执行期间客户端读取任务列表
- **THEN** Cron 服务保持当前内存任务对象，不丢失完成后的状态、历史或一次性任务变更

#### Scenario: 删除任务
- **WHEN** 用户确认删除普通任务
- **THEN** Gateway 删除该任务并返回不再包含它的列表

### Requirement: 保护系统任务
系统 SHALL 将 `system_event` 任务标记为受保护，并在服务端拒绝修改操作。

#### Scenario: 展示系统任务
- **WHEN** 任务的 payload kind 为 `system_event`
- **THEN** 页面将其标记为系统任务并禁用暂停、恢复、立即运行和删除操作

#### Scenario: 绕过前端请求修改系统任务
- **WHEN** 客户端直接请求修改、运行或删除系统任务
- **THEN** Gateway 返回冲突错误且任务保持不变

### Requirement: Automation API 鉴权
Automation 管理接口 MUST 使用 Gateway 现有 API token 鉴权。

#### Scenario: 未认证访问
- **WHEN** 请求未携带有效 Bearer token
- **THEN** Gateway 返回 401 且不泄露任务内容

### Requirement: Cron 存储兼容与数据保护
Cron 存储加载器 SHALL 兼容可恢复的字段差异和局部无效运行历史，同时 MUST 保留现有的完整文件损坏保护。

#### Scenario: 兼容旧字段和空历史
- **WHEN** `jobs.json` 使用受支持的 camelCase 或 snake_case 字段，或运行历史为空值
- **THEN** Cron 服务成功加载任务并使用安全默认值

#### Scenario: 局部运行记录损坏
- **WHEN** 单条 `runHistory` 记录无效但任务主体有效
- **THEN** Cron 服务跳过该记录并保留任务及其他有效记录

#### Scenario: 任务主体不可解析
- **WHEN** 顶层结构或任务必填字段不可解析
- **THEN** Cron 服务保留 `.corrupt-*` 备份并拒绝以空任务列表覆盖原数据
