## Why

nanobot 的主模型（如 DeepSeek）不具备视觉能力，当用户或工具提供图片时，系统只能剥除图片重试或完全忽略视觉内容，导致包含截图、照片、图表的消息无法被正确理解。引入辅助视觉模型后，可在主模型不支持 vision 时自动用视觉模型将图片转述为文字，再交给主模型处理，实现能力互补。

## What Changes

- 新增 `vision_model` / `vision_provider` 配置字段，允许用户为 agent 指定一个独立的辅助视觉模型
- 在 agent turn 状态机中新增 `_state_caption` 步骤（COMMAND → CAPTION → BUILD）：`vision_model` 已配置且消息含图片时，并发调用辅助模型对每张图生成详细文字描述，追加到用户消息文本，清空 `media` 列表；支持部分成功（单张失败不中断 turn）
- `_build_user_content` 保持同步、签名不变；辅助调用在状态机层完成
- 辅助模型的调用结果（caption 文本）随普通文本一起持久化到 session，不存储 base64
- 工具侧（`read_file` / `web_fetch` 返回的图片）本期不在 scope，留后续处理

## Capabilities

### New Capabilities

- `vision-caption`: 辅助视觉模型的调用与图片转述逻辑——接收图片路径列表，返回文字描述，追加到用户消息

### Modified Capabilities

（无现有 spec 需修改）

## Impact

- **配置**：`nanobot/config/schema.py` — `AgentDefaults` 新增 2 个字段；`model_presets` 也可指定 vision 覆盖
- **Agent 状态机**：`nanobot/agent/loop.py` — 在 `COMMAND("dispatch")` → `BUILD` 之间插入 `CAPTION` 步骤
- **Provider 工厂**：`nanobot/providers/factory.py` — 新增 `make_vision_provider()` 函数
- **Context 构建**：`nanobot/agent/context.py` — `_build_user_content` 不改签名，但上层传入时 media 已被清空
- **新文件**：`nanobot/agent/vision_caption.py` — 辅助视觉调用的独立模块（易于测试）
- **依赖**：无新的第三方依赖，复用现有 provider 基础设施
- **无破坏性变更**：未设置 `vision_model` 时行为与现在完全一致
