## ADDED Requirements

### Requirement: 配置辅助视觉模型
系统 SHALL 允许用户在 `agents.defaults` 中配置 `vision_model`（模型名）和 `vision_provider`（provider 名）两个可选字段，用于指定辅助视觉模型。未配置时系统行为 SHALL 与未引入该功能前完全一致。

#### Scenario: 未配置 vision_model 时行为不变
- **WHEN** `agents.defaults.vision_model` 为 null 或未设置
- **THEN** agent 处理图片消息时行为与改动前完全一致，不调用任何辅助模型

#### Scenario: 未配置 vision_model 但主模型返回图片处理错误
- **WHEN** `vision_model` 未配置，主模型因不支持视觉能力而返回错误
- **THEN** 系统在 channel 回复中追加提示语，引导用户配置 `agents.defaults.vision_model`，并给出示例配置

#### Scenario: 配置了 vision_model 但 provider API Key 未填写
- **WHEN** 用户配置了 `vision_model` 但对应 provider 的 `apiKey` 为空
- **THEN** 全部 caption 调用失败，系统在 channel 中发送 warning 提示（含所需 API Key 的字段名），turn 继续执行但所有图片以占位文本代替

---

### Requirement: 图片 caption 自动注入
当配置了辅助视觉模型时，系统 SHALL 在每次 agent turn 的 `_state_caption` 步骤中（COMMAND → CAPTION → BUILD），对 `InboundMessage.media` 中的每张图片调用视觉模型生成文字描述，并将描述追加到消息文本，清空 `media` 列表。

#### Scenario: 成功 caption 单张图片
- **WHEN** 用户消息含 1 张图片，且 `vision_model` 已配置
- **THEN** 视觉模型返回该图片的详细文字描述，描述以 `[图片描述: <caption>]` 格式追加到消息文本末尾，`media` 列表被清空，主模型仅收到文本消息

#### Scenario: 成功 caption 多张图片
- **WHEN** 用户消息含多张图片，且 `vision_model` 已配置
- **THEN** 每张图片各生成独立描述，按顺序以 `[图片 1 描述: ...]`、`[图片 2 描述: ...]` 格式追加，`media` 列表被清空

#### Scenario: 部分图片 caption 失败
- **WHEN** 多张图片中部分调用返回错误（网络故障、超时等）
- **THEN** 成功的图片正常追加 caption 文本，失败的图片追加 `[图片 N: 描述获取失败 - <原因>]` 占位文本，channel 中发送 warning 提示哪些图片处理失败，turn 继续执行不中断

#### Scenario: 全部图片 caption 失败
- **WHEN** 所有图片的 caption 调用均失败（如 provider 鉴权错误）
- **THEN** 所有图片以占位文本代替，channel 中发送 warning 提示辅助视觉模型调用异常，turn 继续执行（主模型至少能看到占位文本和原始消息文字）

#### Scenario: 纯文本消息不触发 caption
- **WHEN** 用户消息 `media` 为空（纯文本），即使 `vision_model` 已配置
- **THEN** `_state_caption` 步骤直接跳过，不调用任何辅助模型

---

### Requirement: caption prompt 要求详细描述
系统 SHALL 使用固定的中文 prompt 调用视觉模型，要求提供尽可能详细的图片描述。识别准确度优先于 token 节约。

> **TODO**: 语言自适应（根据用户消息文本中是否含 CJK 字符选择中/英文 prompt）留待后续实现。

#### Scenario: 使用中文 prompt 描述图片
- **WHEN** 视觉模型被调用
- **THEN** 视觉模型收到中文 prompt，要求详细描述（主体对象、文字信息、布局结构、颜色、数据、关键细节）

---

### Requirement: caption 结果持久化到 session
caption 生成的文字描述 SHALL 作为普通消息文本的一部分持久化到 session 历史中，不单独存储。

#### Scenario: caption 文本随消息写入 session
- **WHEN** 含图片的用户消息经 caption 处理后写入 session
- **THEN** session 中该消息的 `content` 字段包含原始文本与 caption 描述的拼接结果，`media` 字段为空列表或不存在

#### Scenario: 历史消息重放时无需重新 caption
- **WHEN** session 历史被重放用于构建新一轮 LLM 上下文
- **THEN** 历史消息中的 caption 文本直接作为文本内容使用，不重新调用视觉模型

---

### Requirement: 并发 caption 调用
系统 SHALL 对同一消息中的多张图片并发调用视觉模型，而非串行等待。

#### Scenario: 多图并发调用
- **WHEN** 用户消息含 N（N > 1）张图片
- **THEN** 视觉模型的 N 次调用以 `asyncio.gather` 并发执行，总耗时接近单张调用耗时而非 N 倍
