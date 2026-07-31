## Context

lover 分支保留独立 Electron 前端，并通过 Gateway 的 `ForkGatewayHTTPHandler` 访问后端。Cron 任务已经由单一 `CronService` 负责持久化和执行，但该实例目前只注入 Agent，HTTP 层无法查看或控制任务；Electron 也没有 Automation 视图。

上游 0.3.0 的 Automation 页面同时包含会话绑定、编辑器和本地触发器，超出个人统一会话场景的需要。本变更只吸收“可视化查看和基础管理”部分，并保持现有任务格式与投递语义。

## Goals / Non-Goals

**Goals:**

- 通过 Electron 侧边栏直接打开全局 Automation 页面。
- 复用 Gateway 当前运行中的 `CronService`，保证页面操作与实际调度器状态一致。
- 提供查看、暂停/恢复、立即运行、删除四类基础能力。
- 服务端保护 `system_event` 任务，不能依靠前端按钮隐藏来保证安全。
- 对可恢复的 Cron JSON 字段差异做兼容，不因单条无效运行历史破坏全部任务。

**Non-Goals:**

- 不提供创建或编辑任务的表单。
- 不实现上游的本地触发器、会话绑定管理、搜索排序体系和任务级模型配置。
- 不改变统一会话、Cron 执行上下文或主动投递消息的现有逻辑。
- 不修改浏览器 WebUI。

## Decisions

### 复用单一 CronService 实例

`_run_gateway` 将已创建的 `CronService` 依次传给 `ChannelManager`、`WebSocketChannel` 和 `ForkGatewayHTTPHandler`。HTTP 层不重新读取或另建调度器，避免页面状态与运行时定时器分叉。

替代方案是 HTTP 层直接编辑 `jobs.json`，但会绕过锁、重算下次运行时间和定时器重新挂载，因此不采用。

### 使用受现有 token 保护的窄 REST 接口

增加列表、启停、立即运行和删除接口，沿用 Electron 已有 Bearer token。操作接口继续适配当前 WebSocket HTTP 服务器只处理 GET 的约束，以路径和查询参数表达动作。

启停和删除完成后返回最新任务列表。立即运行只负责启动后台任务并立刻返回，
列表通过 `running` 字段暴露执行状态；Electron 在有运行中任务时短间隔轮询，
避免模型调用长时间占用反向代理请求。

### 执行期间保持 Cron store 一致

`CronService` 记录当前执行中的任务 ID。只要存在执行中的任务，读取列表不得从磁盘
替换当前内存 store；同一任务的定时触发和手动触发互斥，重复请求返回“已在运行”。
这样页面刷新不会令运行结果写入已经脱离 store 的旧对象。

### 系统任务只读

`payload.kind == "system_event"` 视为受保护任务。列表会显式返回 `protected: true`；服务端拒绝删除、启停和立即运行，前端同时禁用对应按钮并说明原因。

### 页面是独立主视图，聊天视图保持挂载

`App` 增加 `automations` 视图，侧边栏按钮直接切换。与现有 Settings/Workspace 一致，聊天区域仅隐藏而不销毁，避免返回后消息列表重新加载或滚动位置丢失。

### Cron JSON 仅做可恢复容错

顶层结构、任务主体或必填字段无法解析时，继续将整个文件按现有机制保存为 `.corrupt-*` 并拒绝覆盖。对 `runHistory` 中的局部坏记录则跳过并记录警告；常见 snake_case/camelCase 字段和空容器做兼容。

## Risks / Trade-offs

- [后台任务异常可能无人 await] → Gateway 保存 task 引用并在完成回调中消费异常、记录日志。
- [任务运行期间不重载外部 jobs.json 改动] → 仅延迟到运行结束后的下一次读取；运行时修改仍作用于同一内存 store 并正常保存。
- [页面不能创建或编辑任务] → 明确保留模型创建任务的现有流程，先解决最常用的可见性和控制需求。
- [跳过无效运行历史会损失单条审计信息] → 仅跳过无法构造的历史记录，任务主体仍保留并输出警告。

## Migration Plan

1. 部署后重启 Gateway，使 HTTP 层取得当前 `CronService`。
2. Electron 更新后侧边栏出现 Automation 入口；已有 `jobs.json` 无需迁移。
3. 回滚时移除新页面和接口即可，持久化格式保持兼容。

## Open Questions

无。创建和编辑表单留待实际需要出现后再评估。
