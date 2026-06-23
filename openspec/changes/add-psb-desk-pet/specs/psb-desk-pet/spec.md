## ADDED Requirements

### Requirement: PSB 服务端模型仓库管理
nanobot 服务端 SHALL 在固定目录 `<nanobot-data>/desk_pets/psb/` 管理 PSB 桌宠模型。用户 SHALL 直接将 `.psb` / `.emtbytes` 放入该目录；gateway 启动时 SHALL 自动扫描并注册新文件，并支持删除、重扫和选择多个模型。

#### Scenario: 添加 PSB 模型
- **WHEN** 用户将 `.psb` 或 `.emtbytes` 放入 `desk_pets/psb/` 并重启 gateway
- **THEN** 服务端 SHALL 为该文件生成 sidecar 元数据并登记模型
- **AND** 模型出现在可选择模型列表中

#### Scenario: 选择当前 PSB 模型
- **WHEN** 用户从模型列表中选择某个 PSB 模型
- **THEN** 服务端 SHALL 将 `deskPet.psb.selectedModelId` 更新为该模型 id
- **AND** 后续 PSB 桌宠窗口 SHALL 加载该模型

#### Scenario: 删除非当前模型
- **WHEN** 用户删除一个未被选中的 PSB 模型
- **THEN** 服务端 SHALL 从模型仓库和模型列表中移除该模型
- **AND** 当前选中模型保持不变

#### Scenario: 删除当前模型
- **WHEN** 用户删除当前选中的 PSB 模型
- **THEN** 服务端 SHALL 移除该模型并清空 `selectedModelId`
- **AND** 若 PSB 桌宠窗口正在展示该模型，则窗口显示模型缺失状态或关闭

### Requirement: PSB 模型信息解析和中文元数据
服务端 SHALL 在扫描或重扫 PSB 模型时解析模型能力，并保存中文展示元数据。模型资产 MUST 仅为原始 `.psb` 或 `.emtbytes` 文件，不接受 FreeMote 反编译 JSON + 贴图目录。服务端扫描时 SHALL 至少完成头信息兼容性检查；timeline、表情、face、fade、口型变量等完整能力摘要 MAY 在 PSB 运行时加载后通过重扫回传并持久化。

#### Scenario: 解析 timeline 能力
- **WHEN** 系统成功解析模型的 timeline metadata
- **THEN** 每个 timeline 记录 SHALL 包含原始名称、中文名称、`loopBegin`、`loopEnd`、`lastTime` 和是否循环

#### Scenario: 解析 face 和 fade 能力
- **WHEN** 模型包含 `face_*` 或 `fade_*` 变量
- **THEN** 元数据 SHALL 保存变量名、可选 frame/value、日文原文和中文说明

#### Scenario: 翻译日文描述
- **WHEN** 新增模型时解析到日文 label 或 description
- **THEN** 系统调用翻译能力生成中文文案并持久化
- **AND** 后续设置页 SHALL 直接展示已保存的中文文案，不重新翻译

#### Scenario: 翻译失败
- **WHEN** 模型能力解析成功但翻译失败
- **THEN** 系统 SHALL 保存原文和 `translationStatus: "failed"`
- **AND** 设置页 SHALL 可展示原文并允许用户稍后重试翻译

#### Scenario: 不兼容模型
- **WHEN** 用户添加的 PSB 与 Electron PSB 运行时不兼容
- **THEN** 系统 SHALL 保存失败原因
- **AND** 设置页 SHALL 显示该模型不可用且不得将其设为当前选中模型

### Requirement: PSB 初始状态配置
PSB 配置 SHALL 支持配置初始状态，包括初始 timeline、初始表情、额外 face 变量和 fade 变量。初始 timeline MUST 选择一个循环 timeline。

#### Scenario: 保存合法初始状态
- **WHEN** 用户在 PSB 配置面板选择循环 timeline 并设置表情、face、fade 初始值
- **THEN** 服务端 SHALL 保存这些值为当前模型的初始状态
- **AND** 下次 PSB 桌宠展示时按该初始状态启动

#### Scenario: 拒绝非循环初始 timeline
- **WHEN** 用户尝试把非循环 timeline 保存为初始 timeline
- **THEN** 保存操作 SHALL 被拒绝或保持禁用
- **AND** UI SHALL 提示“初始 timeline 必须选择循环项”

#### Scenario: 保存当前展示状态为初始状态
- **WHEN** 用户在 PSB 窗口配置面板点击“保存为初始状态”
- **THEN** PSB 窗口 SHALL 将当前 timeline、表情、face 和 fade 状态提交给服务端保存
- **AND** 若当前 timeline 非循环，则系统 SHALL 要求用户改选循环 timeline 后再保存

### Requirement: PSB 独立桌宠展示
Electron 应用 SHALL 以独立透明置顶窗口展示 PSB 桌宠。PSB 窗口 SHALL 独立于主聊天窗口，并能够在屏幕范围内拖拽、缩放和关闭。

#### Scenario: 自动展示
- **WHEN** `deskPet.psb.autoShow` 为 true 且存在可用 `selectedModelId`
- **THEN** Electron 启动后 SHALL 自动打开 PSB 桌宠窗口

#### Scenario: 手动打开
- **WHEN** 用户在设置页点击打开 PSB 桌宠
- **THEN** Electron SHALL 创建或聚焦 PSB 桌宠窗口并加载当前选中模型

#### Scenario: 临时关闭
- **WHEN** 用户点击 PSB 桌宠窗口的临时关闭按钮
- **THEN** Electron SHALL 关闭当前 PSB 窗口但不修改 `autoShow`
- **AND** 下次应用启动时若 `autoShow` 仍为 true 则继续自动打开

#### Scenario: 永久关闭
- **WHEN** 用户点击 PSB 桌宠窗口的永久关闭按钮
- **THEN** Electron SHALL 关闭当前 PSB 窗口并将 `deskPet.psb.autoShow` 设置为 false

### Requirement: PSB 窗口控制列
PSB 桌宠窗口 SHALL 在右上角提供与 THA 一致风格的自动隐藏控制列。控制列从上到下 SHALL 依次包含：拖拽、缩放、打开 PSB 配置、开启/关闭鼠标追踪、临时关闭、永久关闭。

#### Scenario: 鼠标移入显示控制列
- **WHEN** 鼠标进入 PSB 桌宠窗口或靠近控制区域
- **THEN** 控制列 SHALL 显示并可点击

#### Scenario: 鼠标移开隐藏控制列
- **WHEN** 鼠标离开 PSB 桌宠窗口且无控制交互进行中
- **THEN** 控制列 SHALL 自动隐藏

#### Scenario: 缩放模型
- **WHEN** 用户使用缩放控制调整比例
- **THEN** PSB 窗口 SHALL 更新模型显示比例
- **AND** 新比例 SHALL 持久化到 PSB 配置

#### Scenario: 打开 PSB 配置
- **WHEN** 用户点击控制列中的配置按钮
- **THEN** Electron SHALL 打开 PSB 配置面板
- **AND** 用户可调整当前模型初始状态并保存

### Requirement: 全屏鼠标追踪
PSB 桌宠 SHALL 支持追踪全屏鼠标位置，而不是仅追踪桌宠窗口内的鼠标位置。系统 SHALL 可配置是否启用鼠标追踪。

#### Scenario: 启用鼠标追踪
- **WHEN** `deskPet.psb.followMouse` 为 true 且 PSB 窗口可见
- **THEN** Electron 主进程 SHALL 节流转发屏幕级鼠标坐标给 PSB 窗口
- **AND** PSB renderer SHALL 将坐标映射到眼、头、身体相关变量

#### Scenario: 关闭鼠标追踪
- **WHEN** 用户点击控制列中的鼠标追踪按钮关闭该能力
- **THEN** 系统 SHALL 保存 `deskPet.psb.followMouse` 为 false
- **AND** PSB renderer SHALL 将追踪相关变量缓动恢复到默认值

### Requirement: PSB 音频口型同步
PSB 桌宠展示时，TTS 音频 SHALL 由 PSB 窗口实际播放。PSB 窗口 SHALL 使用 Web Audio 分析音量并驱动模型口型变量。

#### Scenario: 播放 TTS 音频
- **WHEN** 当前会话产生带音频媒体的 assistant 回复事件
- **THEN** PSB 窗口 SHALL 获取并播放该音频
- **AND** 聊天主窗口不得重复承担 PSB 的口型播放职责

#### Scenario: 口型变量存在
- **WHEN** 当前 PSB 模型支持 `face_talk` 或等价口型变量
- **THEN** PSB 窗口 SHALL 根据 200-3000 Hz 人声音量能量平滑写入口型变量

#### Scenario: 音频结束
- **WHEN** TTS 音频播放结束或停止
- **THEN** PSB 窗口 SHALL 将口型变量恢复为闭嘴状态

### Requirement: PSB AI 标签注入和解析
当 PSB 特殊标签启用时，系统 SHALL 向 AI 注入当前选中 PSB 模型支持的配置类型和标签格式。前端 SHALL 解析 assistant 回复中的 PSB 特殊标签，并将事件同步给 PSB 窗口。

#### Scenario: 注入当前模型能力
- **WHEN** 当前会话构建 AI 上下文且 `deskPet.psb.enabledResponseTags` 为 true
- **THEN** 系统 SHALL 注入当前选中 PSB 模型支持的 timeline、expression、face、fade 能力摘要
- **AND** 注入内容 SHALL 包含可用标签格式示例

#### Scenario: 解析 timeline 标签
- **WHEN** assistant 回复包含 `<psb:timeline name="...">` 或等价格式
- **THEN** 前端 SHALL 从聊天内容中解析该标签并发送 timeline 事件给 PSB 窗口

#### Scenario: 解析 face 和 fade 标签
- **WHEN** assistant 回复包含 PSB face 或 fade 标签
- **THEN** 前端 SHALL 将变量名和值发送给 PSB 窗口
- **AND** 不在当前模型元数据中的变量 SHALL 被忽略或作为不可用标签记录

#### Scenario: 控制标签展示
- **WHEN** `deskPet.psb.showResponseTags` 为 false
- **THEN** 聊天 UI SHALL 在展示 assistant 回复时隐藏 PSB 特殊标签
- **AND** 标签仍 SHALL 被解析并同步给 PSB 窗口

#### Scenario: 标签可见
- **WHEN** `deskPet.psb.showResponseTags` 为 true
- **THEN** 聊天 UI SHALL 保留 PSB 特殊标签的可见展示

### Requirement: PSB 临时状态恢复
PSB 桌宠 SHALL 在临时展示动作完成后恢复到配置的初始状态。非循环 timeline SHALL 在播放结束后恢复初始循环 timeline；表情、face 和 fade 临时状态 SHALL 在流式回复结束或音频结束后恢复。

#### Scenario: 非循环 timeline 播放结束
- **WHEN** PSB 窗口执行一个非循环 timeline 标签
- **THEN** timeline 播放结束后 SHALL 自动切回初始循环 timeline

#### Scenario: 回复流式结束
- **WHEN** 当前 assistant 回复发送完成且没有正在播放的 TTS 音频
- **THEN** PSB 窗口 SHALL 将表情、face 和 fade 恢复为初始状态

#### Scenario: 音频晚于流式结束
- **WHEN** assistant 回复流式已结束但 TTS 音频仍在播放
- **THEN** PSB 窗口 SHALL 等待音频播放结束后再恢复表情、face 和 fade 初始状态
