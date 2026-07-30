## ADDED Requirements

### Requirement: Electron shall present structured agent activity
Electron SHALL render reasoning、Web、MCP、通用工具和文件编辑为可区分的结构化 Activity 行，同时保留无法识别 trace 的通用展示。

#### Scenario: Mixed activity turn
- **WHEN** 一个 assistant turn 同时包含 reasoning、Web 搜索、MCP 调用和文件编辑事件
- **THEN** Electron 按消息顺序展示对应类型的活动行，并将它们保留在同一个 Activity 折叠区域

#### Scenario: Unknown tool trace
- **WHEN** Electron 收到尚未识别的工具 trace
- **THEN** 该 trace 仍以通用工具活动展示，而不是被丢弃

### Requirement: Activity state shall distinguish thinking from working
Electron SHALL 在只有 reasoning 时展示“思考中/思考了”，在包含任意非 reasoning 活动时展示“处理中/处理了”，并显示可用的 turn 持续时间。

#### Scenario: Reasoning-only live turn
- **WHEN** 当前 turn 正在流式输出且仅包含 reasoning
- **THEN** Activity 摘要展示“思考中”和从 turn 起点计算的持续时间

#### Scenario: Tool-using completed turn
- **WHEN** 已完成 turn 包含至少一个工具或文件编辑活动
- **THEN** Activity 摘要展示“处理了”和该 turn 的持久化耗时

### Requirement: File edits shall expose bounded diff data
Gateway SHALL 在可计数的文本文件编辑完成事件中附带受限的 standard unified diff；对于无法安全生成 diff 的文件，该字段 SHALL 省略。

#### Scenario: Text file edited
- **WHEN** 工具完成一次 UTF-8 文本文件编辑且内容发生变化
- **THEN** `file_edit` 完成事件包含路径、增删计数和可解析的 unified diff

#### Scenario: Large diff
- **WHEN** 生成的 diff 超过配置的正文行数或单行长度限制
- **THEN** gateway 截断 payload、标记 `truncated`，且仍返回语法有效的可展示部分

#### Scenario: Binary or unreadable file
- **WHEN** 编辑目标是二进制、过大或不可读文件
- **THEN** gateway 不附带 diff 文本，Electron 仍展示文件状态

### Requirement: Electron shall render file diffs on demand
Electron SHALL 在文件活动行展示状态和增删计数，并允许用户按需展开可用的 diff；缺少 diff 时 SHALL 退化为计数展示。

#### Scenario: Expand available diff
- **WHEN** 用户展开一个包含 diff 的已完成文件编辑
- **THEN** Electron 展示行号、增删标记、上下文行和与文件类型匹配的语法高亮

#### Scenario: Legacy gateway event
- **WHEN** 文件编辑事件只有增删计数而没有 diff 字段
- **THEN** Electron 展示当前计数和状态，且不出现无效的展开控件

#### Scenario: Truncated diff
- **WHEN** diff payload 标记为 `truncated`
- **THEN** Electron 明确提示只展示了部分改动

### Requirement: Activity folding shall preserve reading position
Electron SHALL 在 Activity 内容高度变化时仅为原本贴近底部的会话维持贴底，且不得打断正在阅读历史的用户。

#### Scenario: Activity collapses at bottom
- **WHEN** 用户位于消息列表底部且流式结束使 Activity 自动折叠
- **THEN** 最后一条 assistant 内容和 footer 仍保持可见

#### Scenario: Activity changes while reading history
- **WHEN** 用户已经向上滚动阅读历史且 Activity 内容高度发生变化
- **THEN** Electron 保持用户当前阅读位置，不强制滚动到底部

### Requirement: Activity and footer shall remain readable over dynamic wallpaper
Electron SHALL 在动态壁纸模式下为 Activity 摘要、展开内容和 assistant footer 提供足够对比度，同时保持背景可见。

#### Scenario: Wallpaper mode
- **WHEN** 动态壁纸启用
- **THEN** Activity 标签、详情、token、上下文、耗时和时间戳使用较清晰的前景色与轻微阴影

#### Scenario: Standard background
- **WHEN** 动态壁纸未启用
- **THEN** 新样式不改变普通主题下既有的消息层级和背景透明度
