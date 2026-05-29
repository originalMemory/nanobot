## 1. 配置层

- [x] 1.1 在 `AgentDefaults`（`nanobot/config/schema.py`）中新增 `vision_model: str | None = None` 和 `vision_provider: str | None = None` 字段
- [x] 1.2 在 `ModelPresetConfig` 中同步新增 `vision_model` / `vision_provider` 可选字段，支持 preset 级别覆盖
- [x] 1.3 在 `nanobot/providers/factory.py` 中新增 `make_vision_provider(config)` 函数，复用 `_make_provider_core`，按 `vision_model` / `vision_provider` 字段创建 provider 实例

## 2. 核心 caption 模块

- [x] 2.1 新建 `nanobot/agent/vision_caption.py`，实现 `CaptionResult` dataclass 和 `caption_images(image_paths, provider, model) -> list[CaptionResult]`：并发调用视觉模型（`asyncio.gather(return_exceptions=True)`），支持部分成功——成功的返回描述文本，失败的记录错误信息
- [x] 2.2 使用固定中文 prompt，要求尽可能详细描述（主体对象、文字信息、布局结构、颜色、数据、关键细节），使用 `provider.chat_with_retry` 异步调用。语言自适应留待后续实现
- [x] 2.3 实现 caption 结果格式化：成功时——单图 `[图片描述: <text>]`，多图 `[图片 1 描述: <text>]`；失败时——`[图片 N: 描述获取失败 - <原因>]`

## 3. 状态机集成

- [x] 3.1 在 `TurnState` 枚举中新增 `CAPTION = auto()`，在 `_TRANSITIONS` 表中插入 `(COMMAND, "dispatch") → CAPTION` 和 `(CAPTION, "ok") → BUILD`，使 shortcut 命令自然跳过 caption
- [x] 3.2 新增 `_state_caption(self, ctx: TurnContext) -> str` handler：检查 `ctx.msg.media` 非空且 `vision_model` 已配置，调用 `caption_images`，将成功结果追加到 `ctx.msg.content`、失败结果追加占位文本，清空 `ctx.msg.media`；有失败项时通过 channel 发送 warning 提示但不终止 turn；返回 `"ok"`
- [x] 3.3 在 `base.py._run_with_retry` 的"去图重试"触发分支（`_strip_image_content` 成功时）中，向调用方附加提示文本，引导用户配置 `vision_model`
- [x] 3.4 日志：caption 成功时记录 `debug`（n 张图，耗时），部分失败时记录 `warning`（含失败图片索引和原因），全部失败时记录 `error`

## 4. 单元测试

- [ ] 4.1 测试 `caption_images`：正常路径（mock provider 返回描述）、部分图片失败时返回混合结果（成功+失败）、全部失败时返回全部错误结果
- [ ] 4.2 测试 `_state_caption`：`vision_model=None` 时跳过、`media` 为空时即使配置了 `vision_model` 也跳过、有 media 且配置 vision_model 时调用并修改 `ctx.msg`、部分失败时 turn 继续且 channel 收到 warning
- [ ] 4.3 测试 `base.py` 去图重试分支：strip 触发时附加 `vision_model` 配置提示
- [ ] 4.4 测试配置解析：`vision_model` / `vision_provider` 字段序列化与反序列化
- [ ] 4.5 测试 caption prompt 固定为中文
