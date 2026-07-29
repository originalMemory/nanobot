# Spec: electron-webui-parity-fixes

## Why
- WebUI renderer 迁移遗漏音频、首次认证跳转、Electron 专属操作、Native i18n 和固定头像路由。
- 当前行为弱于旧 Electron，且部分控件暴露了 Electron 不需要的能力。

## Scope
- 本次要做：音频附件分类、签名媒体播放、历史回放和实时消息单次自动播放。
- 本次要做：同 Gateway 首次认证成功后直接进入应用；跨 Gateway 继续由 host 重载。
- 本次要做：Electron 隐藏消息分叉按钮和分叉历史标记。
- 本次要做：Electron 点击模型信息打开预设选择菜单；保留浏览器 WebUI 现有交互。
- 本次要做：补齐动态壁纸、桌面快捷键等 Native 文案 i18n。
- 本次要做：恢复固定 `/api/avatar` 路由并继续读取 media 根目录 `avatar.jpg/png/webp`。
- 本次不做：恢复 AI 回复聚合；修改 TTS provider；改变浏览器会话/分叉能力。

## Plan
- [x] 扩展前后端 audio media kind、MIME 和播放器。
- [x] 恢复实时音频只自动播放一次，历史音频不自动播放。
- [x] 修复认证页同 origin 成功后的状态切换。
- [x] Native 隐藏分叉并增加点击模型预设菜单。
- [x] 补全 Native 设置文案的全部 locale key。
- [x] 恢复 `/api/avatar` handler 并补回归测试。
- [x] 修复历史音频被回放时间误判为实时到达。
- [x] 消除认证页等待初始 Gateway URL 时的提交竞态。
- [x] 补本地 Gateway 恢复页中英文文案。

## Apply Notes
- 同 origin 认证调用 renderer `onSecret`；跨 origin 仍由 Electron `loadURL`。
- audio 允许 MP3/WAV/OGG/AAC/M4A/WebM/FLAC/Opus；未知媒体仍按 file。
- 自动播放仅针对本次页面生命周期内新到达的消息；播放策略拒绝时保留 controls。
- `/api/avatar` 公开只读，文件优先级 `.jpg`、`.png`、`.webp`，与旧 Electron 一致。
- 模型点击菜单只在 Native surface 启用；选择后继续发送 `/model <preset>`。
- 自动播放资格由实时消息链路显式标记，不再依赖持久化时间戳。
- Native 认证提交前必须完成当前 Gateway URL 读取。

## Verify
- [x] 实时音频显示播放器并最多自动播放一次；历史回放不自动播放。
- [x] 首次认证同 Gateway 点击连接后无需重启进入消息列表。
- [x] Electron 不显示分叉按钮和历史分叉标记；浏览器行为不变。
- [x] Electron 点击模型信息可选择其他预设并发送 `/model`。
- [x] 中文环境 Native 壁纸、连接和快捷键文案无英文 fallback。
- [x] `/api/avatar` 返回固定头像；缺失时 404 并使用前端 fallback。
- [x] Python 相关测试与 WebUI test/lint/build、Electron test/typecheck/lint/package 通过。
- [x] Unified Session 旧音频即使回放时间缺失也不自动播放。
- [x] `gateway.getUrl()` 未返回前不能提交连接。
- [x] 头像加载失败展示配置图标 fallback。
- [x] 本轮 WebUI、Electron、Python 定向与全量验证通过。

## Verification Evidence
- `pytest nanobot/channels/websocket/tests/test_websocket_media_route.py tests/utils/test_webui_transcript.py -q`：78 passed。
- `ruff check ...`：相关 Python 文件全部通过。
- `cd webui && npm test -- --run`：49 files / 756 tests passed。
- `cd webui && npm run lint && npm run build`：通过。
- `cd electron && npm test && npm run typecheck && npm run lint && npm run package`：14 tests passed，类型、lint 和 macOS arm64 打包通过。
- `git diff --check`：通过。
- Review fix 定向：WebUI 4 files / 154 tests；Electron 3 files / 16 tests。
- Review fix 全量：WebUI 49 files / 757 tests，lint、typecheck、build 通过。
- Review fix Electron：16 tests，typecheck、lint、macOS arm64 package 通过。
- Review fix Python：78 tests，ruff 通过。

## Status
- State: done
- Archived: yes
