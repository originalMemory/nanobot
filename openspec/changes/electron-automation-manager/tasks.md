## 1. Cron 与 Gateway

- [x] 1.1 提升 `jobs.json` 对字段别名、空容器和局部无效运行记录的加载容错，并补充持久化测试
- [x] 1.2 将 Gateway 使用的单一 `CronService` 实例注入 WebSocket HTTP handler
- [x] 1.3 实现带 token 鉴权的任务列表、启停、立即运行和删除接口，并在服务端保护系统任务
- [x] 1.4 补充 Automation HTTP 路由测试

## 2. Electron 页面

- [x] 2.1 定义 Automation API 类型与请求函数
- [x] 2.2 实现任务列表、状态展示、空态、错误态和基础操作交互
- [x] 2.3 在侧边栏增加直达入口，并保持聊天视图挂载
- [x] 2.4 补充中英文文案和 Electron 组件测试

## 3. 验证

- [x] 3.1 运行相关 Python 测试与 Ruff 检查
- [x] 3.2 运行 Electron 测试、类型检查和构建验证

## 4. Review 修复

- [x] 4.1 保证 Cron 执行期间 store 一致并阻止同一任务并发执行
- [x] 4.2 将立即运行接口改为后台启动并返回任务运行状态
- [x] 4.3 Electron 轮询运行状态、阻止并发操作并修正投递目标文案
- [x] 4.4 补充刷新并发、后台运行和全部系统任务保护测试
- [x] 4.5 重新运行相关测试、构建与 OpenSpec 验证
