## Why

当前定时任务只能通过模型或直接编辑 `jobs.json` 管理，Electron 中缺少可见性和基础操作入口。引入一个轻量的 Automation 页面，可以在不搬入上游完整会话自动化体系的前提下，方便查看和控制现有 Cron 任务。

## What Changes

- 在 Electron 侧边栏增加 Automation 入口，直接打开任务管理页。
- 展示现有 Cron 任务的名称、启用状态、调度方式、下次运行、最近结果与投递目标。
- 支持暂停/恢复、立即运行和删除普通任务；系统任务只读且不可删除或手动运行。
- 增加受现有 Gateway token 保护的 Cron 管理 HTTP API。
- 手动运行采用后台执行与状态轮询，避免长时间占用反向代理请求，并防止同一任务重复执行。
- 提升 `jobs.json` 加载容错，兼容可恢复的旧字段和局部无效运行记录，同时继续保护不可解析的完整存储文件。
- 不引入任务创建/编辑表单、本地触发器、会话级模型选择或上游完整 Automation 工作流。

## Capabilities

### New Capabilities

- `electron-automation-management`: Electron 对现有 Cron 任务的查看与基础控制能力。

### Modified Capabilities

<!-- 无 -->

## Impact

- Electron：`App` 视图切换、侧边栏、Automation 页面、API 类型与 i18n。
- Gateway：`ForkGatewayHTTPHandler` 新增 Automation 路由，并由现有 `CronService` 提供数据和操作。
- Cron：`jobs.json` 解析兼容性和局部容错测试。
- 不新增运行时依赖，不改变既有任务执行、统一会话或消息投递语义。
