## 1. File Diff 数据

- [x] 1.1 为文件编辑完成事件生成受限 unified diff，并补充后端单元测试
- [x] 1.2 扩展 Electron 文件编辑类型与流式合并逻辑，兼容可选 diff 和 operation
- [x] 1.3 增加 Electron unified diff 解析、语言识别和语法高亮组件测试

## 2. Activity 结构化展示

- [x] 2.1 移植并适配 reasoning 和文件编辑 Activity 模型及子组件，保留现有 Web、MCP、CLI 和通用工具渲染器
- [x] 2.2 将现有 AgentActivityCluster 接入子组件，保留 Electron 折叠、CLI/MCP fallback 和消息聚合行为
- [x] 2.3 增加“思考中/处理了”等状态、turn 起点计时和中英文文案
- [x] 2.4 为文件编辑行增加按需展开 diff、截断提示和旧 gateway 降级

## 3. 滚动与视觉

- [x] 3.1 修正 Activity 折叠和内容 resize 时的贴底行为，并覆盖阅读历史场景
- [x] 3.2 调整动态壁纸下 Activity 摘要、详情和 assistant footer 的对比度

## 4. 验证

- [x] 4.1 补充 Electron Activity、文件 Diff 和滚动回归测试
- [x] 4.2 运行相关 Python 测试、Electron 测试、lint 和生产构建

## 5. Review 修复

- [x] 5.1 修复单次工具调用编辑多个文件时的实时合并与历史回放覆盖
- [x] 5.2 修复文件编辑失败态，以及同一路径多次编辑的计数与 Diff 对应关系
- [x] 5.3 将 Diff 高亮调整为每个 hunk 单次渲染
- [x] 5.4 收紧 Activity 拆分的文档范围并重新验证
