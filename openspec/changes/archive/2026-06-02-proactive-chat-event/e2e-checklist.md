# 端到端联调清单

完成所有任务组后，按以下步骤验证完整流程。

## 前置准备

- [x] `config.json` 中 `tools.tts.enabled=true` 且填写有效的 `tools.tts.apiKey`（ZhipuAI 或 OpenAI）
- [x] 设置 `proactiveChat.enabled = true`，`proactiveChat.intervalS = 60`（调小方便测试）
- [x] 主模型需支持视觉（如 GLM-4V、GPT-4o），或配置 `agents.defaults.visionModel`
- [x] 启动 nanobot gateway：`nanobot start`
- [x] 启动 Electron 客户端并连接到 gateway

## 验证步骤

### 1. 焦点上报（task group 4）

- [x] Electron 窗口获焦时，gateway 日志无报错
- [x] 将 Electron 窗口最小化或切换到其他应用，日志应出现焦点变更记录
- [x] 在 gateway 启动日志中看到 `Proactive chat: every 60s` 和隐私提示

### 2. 截图请求（task group 5）

- [x] 在 Python console 调用 `ws_channel.request_screenshot(conn)`，应在 10s 内返回 JPEG 路径
- [x] 检查路径下存在有效 JPEG 文件（`~/.nanobot/media/websocket/screenshots/*.jpg`）

### 3. 主动陪伴触发（task group 7）

- [x] 将 Electron 切到后台，等待 60s（测试用 intervalS）
- [x] gateway 日志应出现：`主动陪伴：触发，chat_id=...`
- [x] 随后出现截图请求日志（或超时降级日志）

### 4. TTS 合成（task group 2-3）

- [x] agent turn 开始后，日志出现 `tts` 工具调用
- [x] `~/.nanobot/media/tts/tts_*.wav`（或 .mp3）文件被创建
- [x] 文件大小 > 1 KB（非空音频）

### 5. 消息下发与播放（task group 6 + 8）

- [x] Electron 前台收到带文字和音频附件的消息气泡
- [x] 音频自动播放（`<audio autoplay>`）
- [x] 播放失败时降级为可点击下载链接

### 6. 静默时段（task group 7）

- [x] 将 `proactiveChat.quietHours` 设为当前时段，验证触发被跳过
- [x] 日志出现：`主动陪伴：静默时段，跳过`

## 回归验证

```bash
# Python 单测
pytest tests/proactive_chat/ tests/channels/test_websocket_screenshot.py \
       tests/channels/test_websocket_presence.py \
       tests/channels/test_websocket_media_route.py \
       tests/providers/test_tts.py tests/agent/tools/test_tts_tool.py -v

# Electron 单测
cd electron && npm test

# ruff 检查
ruff check nanobot/
```
