# Nanobot Electron 基础壳

复用根 `webui/` 的同一份代码，构建进桌面包。第一阶段提供连接页、地址记忆、原生菜单、重连、单实例和窗口生命周期；对话、模型和设置界面使用上游实现。

## 启动

需要 Node.js 22.12+ 与 npm。首次执行：

```sh
npm --prefix webui ci
npm --prefix electron ci
npm --prefix electron run dev
```

先单独启动兼容 v0.3.5 的 gateway，或在连接页输入已有 NAS gateway 的 HTTP(S) origin，例如 `http://nas:8765`。认证密钥在上游登录界面填写，不放进地址。此客户端不启动、停止或修改 NAS gateway。

`dev` 会构建当前 WebUI 再打开 Electron；改 UI 后重新运行即可。仅重新打开已构建界面使用 `npm --prefix electron start`。本阶段不另建 React 项目，也暂不提供 HMR。

可用环境变量指定初始后端：

```sh
NANOBOT_GATEWAY_URL=http://127.0.0.1:8765 npm --prefix electron start
```

后续通过「连接 → 更换后端地址」或 `Cmd/Ctrl+,` 修改。「重新连接」重新载入本地界面。上游尚未完成提供方配置时，会展示它自带的初始化流程。

## 打包与验证

```sh
npm --prefix electron test
npm --prefix electron run test:smoke
npm --prefix electron run package
```

打包输出在 `electron/out/`，默认面向当前系统和架构；这是可运行的应用目录，尚未签名、公证或生成安装器。WebUI 必须先有依赖，桌面依赖和构建产物已忽略，不进入 Git。

## 边界

- 本地 `nanobot://desktop` 协议提供打包的 WebUI，并把 `/api`、`/auth`、`/webui` 请求转给选定 gateway；WebSocket 复用上游 HostSocketBridge，经主进程连接同一 gateway 并使用上游短期 token，支持 NAS 的 HTTP/WS 部署而不关闭混合内容保护。
- 不关闭 webSecurity，不向聊天页暴露 Node 或任意 IPC；连接页的 IPC 校验主 frame 和来源。外部链接交给系统浏览器，拒绝任意本地协议导航。
- 签名图片附件在不带 preload 的独立预览窗口展示，附件只作为图片加载。只有主聊天页面可申请麦克风，系统仍可拒绝；摄像头、附件页与其他来源不获授权。macOS 包包含麦克风用途说明。
- 偏好默认放在系统应用数据目录的 `Nanobot-next/`，与旧 lover 分开；可用 `NANOBOT_DESKTOP_DATA_DIR` 指定隔离目录。不同 gateway 分区保存认证缓存。
- 远端工作区不能用本机目录选择器代替，因此这一阶段不宣称支持原生目录选择、引擎重启或诊断桥接。
- 统一收件箱、托盘/全局截图/通知、MiniMax TTS、本地伴侣视频和记忆迁移尚未接入。当前聊天 ID 与多会话行为沿用上游，不将其伪装成已实现统一聊天。
- 服务端版本若落后于 v0.3.5，新 UI 的部分接口可能不兼容；连接成功不代表旧 lover 后端的所有能力都能直接使用。

本阶段验收：构建和正式 package 命令成功；地址校验、附件路径、脚本语法及 API/静态资源边界测试通过；真实 Electron 进程中验证本地 WebUI、bootstrap、WebSocket、图片预览和模拟消息收发。麦克风测试使用模拟设备且不跳过应用权限处理，不录制真实声音；物理麦克风与 macOS 系统授权交互仍需用户实际验证。模拟链路不消耗模型额度，也不证明真实模型服务可用。
