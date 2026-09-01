# Spec: electron-video-preview

## Why
- 消息视频只能在气泡内小尺寸播放，缺少图片已有的应用级预览。
- 用户需要放大观看，但不希望进入系统全屏。

## Scope
- 本次要做：视频卡片增加“放大预览”按钮，打开 Electron 应用内 Radix Dialog。
- 本次要做：复用图片预览的 `94vw × 92vh` 边界；视频保留比例，不调用系统全屏。
- 本次要做：预览保留原生播放控制、默认静音；支持遮罩点击、关闭按钮和 `Escape` 退出。
- 本次不做：系统全屏、画中画、视频列表左右切换、下载按钮、浏览器 WebUI。

## Plan
- [x] 新增轻量 `VideoPreviewDialog`，复用图片预览的 Radix Portal/Overlay/no-drag 规则。
- [x] `MessageBubble` 视频卡片增加放大按钮并接入 Dialog。
- [x] 增加组件测试，验证打开、有限尺寸、默认静音和关闭。
- [x] 执行 Electron 全量测试与打包。

## Apply Notes
- 内联播放器保持现状；放大按钮独立于播放控制，避免点击视频时误开弹窗。
- 预览使用同一签名 URL；`preload="metadata"`，不自动播放。

## Verify
- [ ] 点击视频卡片放大按钮后，预览在应用级遮罩中打开，尺寸未覆盖整个窗口。
- [ ] 预览可播放、暂停、拖动进度、调音量，默认静音。
- [ ] `Escape`、关闭按钮和遮罩点击均可关闭，内联视频仍可使用。
- [x] `npm test` 与 `npm run package` 通过。

## Status
- State: doing
- Archived: no
