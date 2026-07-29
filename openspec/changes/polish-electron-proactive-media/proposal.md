## Why

Electron 复用远端 WebUI 后，主动推送轮次头、首次动态壁纸和音频展示仍有三处体验回归。现有数据与能力均已具备，本次收紧前端分组与展示时机即可恢复预期。

## What Changes

- 将每条无 user 前置的主动推送视为独立轮次，展示一次 AI 头像、昵称和来源。
- Electron renderer 注册壁纸监听后立即同步缓存或触发首次抓取。
- WebUI 音频仅展示原生播放器，移除额外半透明边框和可见文件名。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `bot-identity-in-thread`: 主动推送作为独立轮次展示身份与来源。
- `electron-app`: 动态壁纸在首次打开时完成一次可靠同步。
- `audio-message-playback`: WebUI 音频播放器采用无额外卡片装饰的紧凑展示。

## Impact

- `webui/src/components/thread/ThreadMessages.tsx`
- `electron/src/main.ts`
- `webui/src/components/AttachmentTile.tsx`
- 对应 WebUI/Electron 单元测试
