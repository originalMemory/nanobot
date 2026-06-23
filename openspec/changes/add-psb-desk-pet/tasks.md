## 1. 配置与 API 基础

- [x] 1.1 在后端配置 schema 中新增统一 `deskPet` 结构，包含 `tha` 和 `psb` 子配置
- [x] 1.2 明确不实现旧顶层 `tha` 配置迁移，设置读写只面向新的 `deskPet` 结构
- [x] 1.3 扩展设置 API 的 payload/update 类型，返回并保存统一桌宠配置
- [x] 1.4 更新 Electron renderer 的 settings 类型和 API 客户端，适配 `deskPet` payload
- [x] 1.5 为 `deskPet` settings API 读写补充后端测试

## 2. 服务端 PSB 模型仓库

- [x] 2.1 固定 PSB 目录：`<nanobot-data>/desk_pets/psb/`（平铺存放模型文件）
- [x] 2.2 固定目录 `desk_pets/psb/` 平铺存放 `.psb` / `.emtbytes`；gateway 启动时扫描并生成 `<文件名>.meta.json`
- [x] 2.3 实现 PSB 模型列表、详情、删除、重扫、当前选中和初始状态保存 API
- [x] 2.4 实现服务端模型资源 manifest 和受控资源读取/下载接口
- [x] 2.5 为模型上传、资源路径限制、删除当前模型和模型列表 API 补充后端测试

## 3. PSB 模型导入、解析与翻译

- [x] 3.1 移植或封装 PSB 头信息检查与兼容性判断；完整 timeline/变量元数据由运行时加载后重扫补齐
- [x] 3.2 实现服务端模型导入流程：接收上传文件、落入模型仓库、生成稳定 `modelId`
- [x] 3.3 解析 timeline、循环标记、expression、face、fade 和口型变量支持状态
- [x] 3.4 实现模型兼容性检查，保存不可用模型的失败原因
- [x] 3.5 实现日文 label/description/hint 翻译流程，保存中文文案、原文和翻译状态
- [x] 3.6 支持对服务端模型仓库中的已登记模型执行重扫和重试翻译
- [x] 3.7 为模型解析、翻译失败 fallback、不可用模型和删除当前模型场景补充测试

## 4. PSB Electron IPC 与窗口

- [x] 4.1 在主进程新增 PSB BrowserWindow 管理：打开、聚焦、关闭、关闭全部和退出清理
- [x] 4.2 在 preload 暴露 `electronAPI.psb` 命名空间：open/close/saveWindowState/sendAction
- [x] 4.3 实现 PSB 文件选择与上传桥接：Electron 读取用户选择的 `.psb` / `.emtbytes` 并调用服务端模型上传 API
- [x] 4.4 实现启动时自动展示：`autoShow=true` 且选中模型可用时打开 PSB 窗口
- [x] 4.5 扩展 Electron `AppConfig` / electron-store defaults，仅保存 PSB 窗口位置、尺寸、缩放和临时关闭状态
- [x] 4.6 区分临时关闭和永久关闭：临时关闭只关窗口，永久关闭调用服务端 API 写入 `autoShow=false`
- [x] 4.7 为 PSB IPC 参数校验、重复窗口复用、上传桥接和关闭语义补充测试

## 5. PSB Renderer 运行时

- [x] 5.1 创建 PSB 专用 renderer 页面，加载 E-mote WebGL runtime
- [x] 5.2 实现从服务端模型 resource manifest 加载当前 PSB 模型资源
- [x] 5.3 移植 timeline 播放、expression/face/fade 状态应用、初始状态恢复逻辑
- [x] 5.4 实现右上角自动隐藏控制列：拖拽、缩放、临时关闭、永久关闭
- [x] 5.5 实现窗口拖拽、模型缩放和缩放比例持久化
- [x] 5.6 实现非循环 timeline 播放结束后恢复初始循环 timeline
- [x] 5.7 实现 expression/face/fade 在流式结束或音频结束后恢复初始状态
- [x] 5.8 为 PSB renderer 状态 reducer/动作应用逻辑补充单元测试

## 6. 鼠标追踪与口型同步

- [x] 6.1 在主进程实现全屏鼠标坐标采集和节流转发，窗口关闭/隐藏/禁用时停止
- [x] 6.2 在 PSB renderer 中将全局坐标映射到眼、头、身体追踪变量
- [x] 6.3 实现鼠标追踪开关，从控制列和设置页同步到 `deskPet.psb.followMouse`
- [x] 6.4 复用 THA 策略，在 PSB 窗口播放 TTS 音频并用 Web Audio 分析 200-3000 Hz 人声音量
- [x] 6.5 将音量映射到 `face_talk` 或模型元数据中声明的等价口型变量，并在音频结束后闭嘴
- [x] 6.6 为坐标转发节流、追踪关闭恢复和口型音量映射补充测试

## 7. AI 标签注入与回复解析

- [x] 7.1 根据当前选中 PSB 模型元数据构建短 prompt，说明可用 timeline/expression/face/fade 标签格式
- [x] 7.2 在 agent 上下文构建或 Electron 会话入口中按配置注入 PSB 标签说明
- [x] 7.3 实现 assistant 回复中的 PSB 标签解析，规范化为 timeline/expression/face/fade 动作事件
- [x] 7.4 根据 `showResponseTags` 控制聊天 UI 是否展示原始 PSB 标签
- [x] 7.5 将解析出的动作事件转发给已打开的 PSB 窗口
- [x] 7.6 处理无窗口、未知模型能力和无效标签场景，确保回复展示不报错
- [x] 7.7 明确自定义别名为后续能力，本次只支持模型元数据中的原始/中文名称直接引用
- [x] 7.8 为标签注入、标签隐藏/保留、无效标签忽略和状态恢复触发补充测试

## 8. 设置页 UI

- [x] 8.1 将 SettingsLayout 导航从 8 个分区扩展为 9 个分区，新增「桌宠」
- [x] 8.2 将 THA 设置放到桌宠分区的 THA 子区，读写 `deskPet.tha`，不实现旧 `tha` 配置迁移
- [x] 8.3 实现 PSB 子区：基础开关、当前模型、自动展示、鼠标追踪、标签启用和标签可见性
- [x] 8.4 实现 PSB 模型管理 UI：删除、重扫、重试翻译、解析/翻译状态展示（手动放目录，无上传/扫描按钮）
- [x] 8.5 实现 PSB 初始状态配置 UI，只允许保存循环 timeline 作为初始 timeline
- [x] 8.6 实现打开/关闭 PSB 桌宠入口，并与 PSB IPC 对接
- [x] 8.7 补充 Electron 设置页渲染和交互测试

## 9. 验证与回归

- [x] 9.1 运行后端配置/settings 相关 pytest
- [x] 9.2 运行 Electron renderer 单元测试和类型检查
- [ ] 9.3 手动验证新 `deskPet.tha` 配置下 THA 仍可打开、音频口型仍可用
- [ ] 9.4 手动将兼容 PSB 放入 `desk_pets/psb/` 并重启 gateway，验证解析、中文元数据、选择和初始状态保存
- [ ] 9.5 手动验证 PSB 自动展示、拖拽、缩放、鼠标追踪、临时关闭和永久关闭
- [ ] 9.6 手动验证 TTS 音频由 PSB 窗口播放并驱动口型
- [ ] 9.7 手动验证 AI 回复中的 PSB 标签能驱动 timeline/expression/face/fade，并按规则恢复初始状态
