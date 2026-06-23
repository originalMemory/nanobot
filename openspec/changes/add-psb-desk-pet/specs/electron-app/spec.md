## ADDED Requirements

### Requirement: PSB 桌宠窗口管理
Electron 主进程 SHALL 支持创建、聚焦、关闭和查询 PSB 桌宠透明窗口。PSB 窗口 SHALL 独立于主窗口，默认透明、置顶且不显示系统窗口边框。

#### Scenario: 创建 PSB 窗口
- **WHEN** renderer 通过 IPC 请求打开 PSB 桌宠窗口
- **THEN** 主进程 SHALL 创建或聚焦一个 PSB BrowserWindow
- **AND** 该窗口 SHALL 加载 PSB 专用 renderer 页面

#### Scenario: 避免重复窗口
- **WHEN** PSB 窗口已经存在且未销毁时再次请求打开
- **THEN** 主进程 SHALL 聚焦或显示现有窗口
- **AND** 不得创建重复 PSB 窗口

#### Scenario: 关闭全部 PSB 窗口
- **WHEN** renderer 通过 IPC 请求关闭 PSB 桌宠
- **THEN** 主进程 SHALL 关闭所有 PSB 桌宠窗口

### Requirement: PSB IPC bridge
Electron preload SHALL 暴露 PSB 命名空间 IPC。该命名空间 SHALL 支持打开窗口、关闭窗口、保存本地窗口状态和发送运行时动作。模型删除、重扫、获取模型列表、保存模型配置和重试翻译 SHALL 通过服务端 API 完成；模型文件由用户手动放入固定 `desk_pets/psb/` 目录并在 gateway 启动时注册。

#### Scenario: 打开窗口 IPC
- **WHEN** renderer 调用 `electronAPI.psb.open`
- **THEN** preload SHALL 调用主进程 PSB 打开窗口 handler
- **AND** 返回成功状态或错误原因

#### Scenario: 保存窗口状态 IPC
- **WHEN** renderer 调用 `electronAPI.psb.saveConfig`
- **THEN** 主进程 SHALL 保存 PSB 窗口位置、尺寸、缩放等本地窗口状态
- **AND** 服务端 PSB 配置 SHALL 通过设置 API 保存
- **AND** Electron SHALL 通知已打开的 PSB 窗口应用新配置

### Requirement: PSB 服务端模型资源访问
PSB renderer SHALL 从 nanobot 服务端获取当前模型资源。Electron 主进程 SHALL 不把本地导入目录作为模型权威来源；本地缓存仅可作为服务端资源的加速副本。

#### Scenario: 获取模型文件 URL
- **WHEN** PSB renderer 需要加载当前模型资源
- **THEN** renderer SHALL 请求服务端返回当前模型的资源 manifest 和受鉴权保护的资源 URL
- **AND** 资源访问 SHALL 限定在服务端已登记的 PSB 模型目录内

#### Scenario: 拒绝未登记资源
- **WHEN** renderer 请求访问未登记模型或未登记资源
- **THEN** 服务端 SHALL 拒绝请求并返回错误

#### Scenario: 重扫服务端模型
- **WHEN** 用户请求重扫某个已登记 PSB 模型
- **THEN** Electron SHALL 调用服务端重扫 API
- **AND** 服务端 SHALL 重新读取模型仓库中的 PSB 文件并更新元数据；若 PSB 窗口已加载该模型，则 MAY 合并运行时回传的能力摘要

### Requirement: PSB 全屏鼠标坐标转发
Electron 主进程 SHALL 在 PSB 鼠标追踪启用时采集全屏鼠标坐标，并转发给 PSB 窗口。坐标转发 SHALL 在窗口关闭、隐藏或追踪禁用时停止。

#### Scenario: 开始坐标转发
- **WHEN** PSB 窗口可见且 `deskPet.psb.followMouse` 为 true
- **THEN** 主进程 SHALL 以节流频率读取屏幕鼠标坐标
- **AND** 将坐标发送到 PSB 窗口 renderer

#### Scenario: 停止坐标转发
- **WHEN** PSB 窗口关闭、隐藏或用户关闭鼠标追踪
- **THEN** 主进程 SHALL 停止鼠标坐标采集和转发

#### Scenario: 多显示器坐标
- **WHEN** 用户在多显示器环境中移动鼠标
- **THEN** 主进程 SHALL 转发全局屏幕坐标
- **AND** PSB renderer SHALL 能够根据窗口 bounds 映射到模型追踪变量

### Requirement: PSB 音频和标签事件转发
Electron 应用 SHALL 将 assistant 回复中的 TTS 音频事件和 PSB 标签事件转发给已打开的 PSB 桌宠窗口。

#### Scenario: 转发音频事件
- **WHEN** Electron renderer 收到 assistant 回复的音频媒体事件
- **THEN** 应用 SHALL 将音频 URL 或可播放资源引用发送给 PSB 窗口
- **AND** PSB 窗口 SHALL 负责播放和口型同步

#### Scenario: 转发标签事件
- **WHEN** Electron renderer 从 assistant 回复中解析出 PSB 标签
- **THEN** 应用 SHALL 将规范化后的动作事件发送给 PSB 窗口

#### Scenario: 窗口未打开
- **WHEN** PSB 标签或音频事件到达但 PSB 窗口未打开
- **THEN** 应用 SHALL 丢弃该临时事件或记录调试信息
- **AND** 不得因此打开 PSB 窗口，除非 `autoShow` 触发了窗口展示

### Requirement: PSB 自动启动生命周期
Electron 主进程 SHALL 在应用启动后根据 PSB 配置自动打开桌宠窗口，并在应用退出时清理 PSB 资源。

#### Scenario: 启动自动打开
- **WHEN** Electron 应用 ready 且 `deskPet.psb.autoShow` 为 true
- **AND** 当前选中模型可用
- **THEN** 主进程 SHALL 自动打开 PSB 桌宠窗口

#### Scenario: 无可用模型不自动打开
- **WHEN** `deskPet.psb.autoShow` 为 true 但没有可用 `selectedModelId`
- **THEN** 主进程 SHALL 不打开 PSB 桌宠窗口
- **AND** 设置页 SHALL 能显示模型缺失原因

#### Scenario: 应用退出清理
- **WHEN** Electron 应用退出
- **THEN** 主进程 SHALL 停止 PSB 鼠标追踪计时器、关闭 PSB 窗口并释放临时资源
