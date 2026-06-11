# Spec: electron-upload-all-files

## Why
- Electron 输入框附件仅支持 4 种图片 MIME，用户无法上传 PDF、代码、配置等常见文件。
- 后台 `extract_documents` 已能解析部分文档类型，但 WebSocket 入口在 MIME 白名单处拒绝非图/视频文件，链路不通。

## Scope
- **阶段 1（当前）**：仅支持 `extract_documents` 已覆盖的类型（图 + pdf/docx/xlsx/pptx + 文本扩展名，含 `.py`/`.sh`）。
- 本次要做：Electron 附件选择/拖拽/粘贴接受上述扩展名；图片仍走 Worker；文档走 FileReader base64。
- 本次要做：WebSocket 放宽 MIME 白名单；落盘保留原始扩展名供 `extract_documents` 识别。
- 本次不做：任意文件上传、未知扩展 fallback 读文本、webui 同步。

## Plan
- [x] 新增 `electron/src/renderer/lib/attachmentTypes.ts` 扩展名白名单。
- [x] 扩展 `useAttachedImages`：图片/文档双路径；上限 8 附件、4 图。
- [x] `useClipboardAndDrop` 接受白名单内文件。
- [x] `ThreadComposer` chip/文案/i18n；文档 optimistic bubble 仅显示文件名。
- [x] `websocket.py` + `media_decode.py`：文档 MIME、扩展名校验、name 保留后缀。
- [x] 测试：`test_websocket_envelope_media.py` 补 PDF/混合用例。
- [x] 手动验证。

## Apply Notes
- 白名单与 `nanobot.utils.document.SUPPORTED_EXTENSIONS` 对齐；SVG 前后端均拒绝。
- `save_base64_data_url(name=...)` 优先用客户端文件名的后缀落盘。
- 文档 optimistic preview 不传 `url`，避免 `UserImages` 把 PDF data URL 当 `<img>` 渲染。

## Verify
- [x] 选择 `.png`：vision 正常。
- [x] 选择 `.pdf`/`.docx`/`.md`：AI 上下文含提取正文。
- [x] 选择 `.exe`/`.zip`：前端拒绝。
- [x] 图 + 文档混合一条消息可发送。

## Status
- State: done
- Archived: yes
