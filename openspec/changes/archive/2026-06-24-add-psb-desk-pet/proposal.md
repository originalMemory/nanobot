## Why

现有 THA 桌宠已经跑通了独立窗口、音频口型和 AI 标签驱动，但配置仍以 THA 为中心，且 THA 只支持固定模型。引入 PSB/E-mote 桌宠需要统一桌宠配置入口，并支持服务端管理多个可替换模型、Electron 展示和回复标签联动。

## What Changes

- 新增统一 `deskPet` 配置字段，将现有 THA 配置放入 `deskPet.tha`，并新增并列的 `deskPet.psb` 配置；不要求兼容旧顶层 `tha` 配置迁移。
- Electron 设置页展示统一桌宠配置，保留 THA 入口，同时新增 PSB 模型管理、当前选中、自动展示、鼠标跟随、回复特殊标签和初始状态配置。
- 移植 `/Users/illusion/dev/self/gal-char-anim` 中 `apps/emote-viewer` 的 E-mote WebGL 逻辑，在 Electron 中以独立透明桌宠窗口展示 PSB 模型。
- PSB 支持多个模型：Electron 提供上传入口，服务端接收、存储、解析模型信息，提取 timeline、表情、face、fade 等能力，并将日文描述翻译为中文后保存，后续设置页直接展示中文。
- PSB 桌宠窗口提供右上角自动隐藏控制列，按钮从上到下为拖拽、缩放、打开 PSB 配置、开启/关闭鼠标追踪、临时关闭、永久关闭。
- 桌宠展示时由 PSB 窗口播放 TTS 音频，并像 THA 一样用 Web Audio 分析音量驱动口型。
- 启用 PSB 后，AI 上下文注入当前选中模型支持的配置类型与特殊标签格式；前端解析回复中的标签并同步给桌宠展示。
- 非循环 timeline 播放结束后切回初始循环 timeline；表情、face、fade 等非 timeline 状态在流式回复结束后切回初始状态。

## Capabilities

### New Capabilities

- `psb-desk-pet`: PSB/E-mote 桌宠模型管理、能力解析、独立窗口展示、口型同步、鼠标追踪、AI 特殊标签驱动和初始状态恢复。

### Modified Capabilities

- `electron-settings-ui`: 设置页新增统一桌宠配置区，展示 THA 配置和新增 PSB 配置。
- `electron-local-preferences`: Electron 本地偏好新增桌宠窗口状态与临时关闭状态等客户端状态。
- `electron-app`: Electron 主进程新增 PSB 桌宠透明窗口、全屏鼠标位置追踪、模型上传入口和桌宠窗口 IPC。

## Impact

- **配置 schema**：`nanobot/config/schema.py` 增加 `deskPet` / `desk-pet` 结构，本变更不要求旧顶层 `tha` 配置迁移。
- **后端 API**：设置 API 暴露并保存统一桌宠配置；新增 PSB 模型上传、列表、删除、重扫、元数据、资源读取/下载接口；新增或扩展桌宠事件通道，向 Electron/前端广播 TTS 音频和标签事件。
- **Electron main/preload**：新增 PSB 窗口管理、PSB 文件选择与上传、屏幕级鼠标坐标转发、临时/永久关闭控制。
- **Electron renderer**：新增 PSB 设置 UI、模型管理 UI、PSB 桌宠页面和控制列；与现有 THA 设置共存。
- **WebUI/流式展示**：根据配置决定是否在回复里展示特殊标签；解析标签后转发给桌宠，并从可见回复中隐藏或保留标签。
- **模型资产**：PSB 模型默认存放在 nanobot 服务端数据目录的模型仓库中，Electron 负责上传入口和桌宠展示；跨平台客户端可复用同一服务端模型集合。
- **依赖/资源**：引入或复用 E-mote WebGL 运行时资源（`emotedriver.js`、`emoteplayer.js`、WASM/polyfill 等）及模型解析逻辑。
