## 1. TTS preset core

- [x] 1.1 定义 preset、音色与活动选择 schema，移除旧直连 TTS 字段。
- [x] 1.2 解析活动 preset 与按语言选择的 voice ID。
- [x] 1.3 让工具、自动朗读与 fallback 使用解析后的运行时配置。

## 2. 设置接口与界面

- [x] 2.1 扩展设置 payload 和 TTS 更新接口。
- [x] 2.2 更新 Electron TTS 设置页与类型，显示 preset / 音色中文名称。
- [x] 2.3 更新中英文设置文案与 Electron 测试。

## 3. 配置与验证

- [x] 3.1 将实际 config 改为 MiniMax 与 IndexTTS presets。
- [x] 3.2 补充 schema、运行时、设置 API 测试。
- [x] 3.3 运行 Python、Electron 测试和静态检查。
- [x] 3.4 缓存主备 provider 并校验音色 id / label 非空。
