## Context

nanobot 的图片处理流水线：Channel 收到图片后保存为本地路径，进入 `InboundMessage.media`；`AgentLoop._state_restore` 调用 `extract_documents` 将图片路径与文档路径分离；`_state_build` 调用 `context.build_messages` → `_build_user_content`，将图片路径读取并 base64 编码，组装成 `image_url` 块发给 LLM。

当前问题：若主模型不具备 vision 能力（如 DeepSeek），LLM 返回非瞬时错误时 `base.py._strip_image_content` 仅做降级（去图重试），无法理解图片内容。

约束：`_build_user_content` 为同步方法，全量被 3 处调用（初始 turn、子消息注入、子 agent callback），贸然改为 async 传染性大。

状态机 driver 的工作方式：每个 `_state_xxx` handler 返回一个 **event 字符串**（如 `"ok"`、`"dispatch"`、`"shortcut"`），driver 根据 `(当前状态, event)` 在 `_TRANSITIONS` 字典中查找下一状态。handler 的 Python 返回类型声明应为 `str`（非 `TurnState`）。

## Goals / Non-Goals

**Goals:**
- 引入 `vision_model` / `vision_provider` 配置字段
- 在 `_state_command` 返回 `"dispatch"` 后、`_state_build` 之前，执行异步 `_state_caption` 步骤
- caption 结果作为普通文本追加到 `msg.content`，清空 `msg.media`，后续链路零感知
- `vision_model` 未配置时行为与现在完全一致（无 breaking change）
- caption 调用结果随普通文本持久化到 session

**Non-Goals:**
- 工具侧图片（`read_file` / `web_fetch` 产生的 `build_image_content_blocks`）本期不处理
- 历史图片 re-hydrate（仅处理当前 turn 新上传的图片）
- 自动检测主模型是否有 vision 能力（用户显式配置 `vision_model` 即表示「需要辅助」）

## Decisions

### 决策 1：在状态机层做 caption，插入点为 COMMAND → BUILD 之间

**选择**：在 `_state_command` 返回 `"dispatch"` 之后、`_state_build` 执行之前，新增 `_state_caption` 异步步骤。状态转移路径为：

```
COMMAND("dispatch") → CAPTION → BUILD
COMMAND("shortcut") → DONE（跳过 caption）
```

该步骤直接修改 `ctx.msg`：将 caption 文本追加到 `content`，清空 `media`。

**为何不插在 RESTORE → COMPACT 之间**：CAPTION 需要 `ctx.session` 已完成 restore 和 compact，且 shortcut 命令（`/new` 等）不需要处理图片，放在 COMMAND 之后可自然跳过。

**备选**：将 `_build_user_content` 改为 async，在内部调用辅助模型。

**拒绝原因**：`_build_user_content` 有 3 处调用点，其中 `_to_user_message`（子消息注入）为闭包内同步调用；改为 async 需要级联修改 runner callback 签名，牵连面广，且子消息场景中通常无 media（子消息来自频道新消息，已过 extract_documents）。状态机层插入更干净，改动隔离。

**注意**：`_state_caption` 接收到的 `ctx.msg.media` 已经由 `_state_restore` 中的 `extract_documents` 处理过，仅包含图片路径（PDF 等文档路径已被分离为文本追加到 `content`），无需再过滤文件类型。

### 决策 2：新建 `nanobot/agent/vision_caption.py` 独立模块

不在 `loop.py` 内联，便于单独测试与复用（后续工具侧图片处理也可复用）。

模块签名：
```python
@dataclass
class CaptionResult:
    """单张图片的 caption 结果。"""
    index: int
    path: str
    text: str | None       # 成功时为描述文本
    error: str | None      # 失败时为错误信息

async def caption_images(
    image_paths: list[str],
    provider: LLMProvider,
    model: str,
) -> list[CaptionResult]:
    """对每张图片并发调用视觉模型，返回等长结果列表。支持部分成功。"""
```

对每张图独立调用（不批处理），使用 `asyncio.gather(return_exceptions=True)` 并发执行。单张失败不中断其余调用，结果列表中标记成功/失败状态，由调用方（`_state_caption`）决定如何处理（见决策 5）。

### 决策 3：`vision_model` 的存在即视觉能力声明，不做自动检测

不为 `ProviderSpec` 添加 `supports_vision` 字段，也不做模型名正则匹配。理由：provider registry 中的网关类 provider（OpenRouter、SiliconFlow 等）的视觉能力取决于所选的具体模型，provider 级别的标记无法准确描述；本地模型（Ollama、vLLM）更无法静态判断。

**语义约定**：`vision_model` 有值 → 用辅助模型 caption 后发给主模型；`vision_model` 为 null → 原样发图给主模型（现有行为）。用户通过配置声明意图，系统不猜测。

### 决策 4：`vision_model` 未配置时图片进入消息 → 在日志中输出明确提示

当 `vision_model` 未配置且主模型收到图片（可能不支持视觉）时，系统在收到 LLM 错误响应后，在 **channel 回复** 和日志中输出提示语，引导用户配置辅助视觉模型：

```
⚠️ 图片无法处理：当前主模型不支持视觉能力。
可在 config.json 中配置 agents.defaults.vision_model 来启用辅助视觉模型。
示例：{"agents": {"defaults": {"vision_model": "gemini-2.5-flash", "vision_provider": "gemini"}}}
```

该提示在 `base.py._run_with_retry` 现有的"去图重试"分支中注入（检测到 strip 成功触发时），不需要另加配置项。

### 决策 5：caption 支持部分成功，不因单张失败中断整个 turn

并发调用 `asyncio.gather(return_exceptions=True)`，结果分为成功和失败两类：
- **成功**的图片：正常追加 caption 文本到消息
- **失败**的图片：追加 `[图片 N: 描述获取失败 - <原因>]` 占位文本，同时在 channel 中发送 warning 提示（不终止 turn）

**全部失败**时仍继续 turn（主模型至少能看到占位文本和原始消息文字），但在 channel 中追加明确的 warning 提示辅助视觉模型调用异常。

**拒绝方案**：任意一张失败即终止 turn——用户发 5 张图时因网络抖动丢 1 张就整体挂掉，体验过差。

### 决策 6：caption prompt 暂时固定为中文，要求尽可能详细描述

caption prompt 使用固定的中文 prompt，要求模型提供**尽可能详细**的描述。识别准确度比 token 消耗更重要。

```
请详细描述这张图片的内容。包括：主体对象、文字信息、布局结构、颜色、数据、关键细节等所有可识别的视觉元素。尽可能完整，不要遗漏重要信息。
```

> **TODO**：语言自适应留待后续实现——检测 `msg.content` 中是否含 CJK 字符（`\u4e00-\u9fff`）来选择中/英文 prompt；纯图消息（`msg.content` 为空）默认英文。届时 `caption_images` 需重新接收 `context_hint` 参数。

### 决策 7：`vision_model` 字段加到 `AgentDefaults`，同时支持 `model_presets` 覆盖

```python
class AgentDefaults(Base):
    ...
    vision_model: str | None = None      # e.g. "gpt-4o-mini"
    vision_provider: str | None = None   # e.g. "openai"；None 时走 auto-detect
```

`model_presets` 中的 `ModelPresetConfig` 也可加同名字段，优先级高于 `defaults`。

## Risks / Trade-offs

**[风险] caption 调用增加每次 turn 的延迟**
→ 接受：caption 调用并发（`asyncio.gather`），总延迟接近单张调用耗时；延迟增加可接受。

**[风险] vision provider 鉴权/网络失败导致部分图片无法描述**
→ 设计选择：支持部分成功——成功的图片正常 caption，失败的图片追加占位文本 `[图片 N: 描述获取失败 - <原因>]` 并在 channel 中 warning，turn 继续执行。用户能看到哪些图片处理成功、哪些失败，不因网络抖动丢 1 张就整体挂掉。

**[风险] 用户配置了 `vision_model` 但 API Key 未填写**
→ 首次失败时在 channel 回复中输出明确的配置错误提示（含 provider 名称和所需 API Key 名称）。

**[风险] 主模型没有视觉能力但用户未配置 `vision_model`**
→ 设计选择：LLM 报错后 `base.py` 触发去图重试时，同步在 channel 回复中追加提示语，引导用户配置 `vision_model`（见决策 4）。

**[接受] caption 文本增大 token 用量**
→ 替代方案（strip 图片）同样损失信息。详细描述模式下 caption 文本约 100-300 tokens/图，但识别准确度优先于 token 节约，可接受。

**[Trade-off] 本期不处理工具侧图片**
→ 工具侧图片指 `read_file` / `web_fetch` 返回的图片内容，直接作为 tool result 注入 LLM messages，不经过 `_build_user_content`。若主模型无视觉能力，这部分仍被 `_strip_image_content` 降级；本期只处理用户上传图片，工具侧留后续。

## Migration Plan

- 纯新增字段，未配置时行为不变，无需迁移。
- 若用户已有 `fallback_models` 中配置视觉模型作为 workaround，两者可共存（caption 先跑，fallback 在 provider 层保底）。

## Open Questions

- 是否要在 WebUI / Electron 设置页面暴露 `vision_model` 配置？本期通过 `config.json` 配置，设置 UI 留后续。
- 是否需要将 caption 结果单独记录在 session metadata 中以供调试？当前方案直接追加到 text，不单独记录。
