# Spec: tts-summary-threshold

## Why

- 每轮带语音至少 2 次全上下文请求：模型先发纯 tts 轮（`content` 空 + `tts` 工具调用），工具返回后再发正文轮。实测：115 个含 tts 轮整轮输入/上下文中位 2.99，简单轮恰好 2.0；无工具纯正文轮 `request_count=1` 整轮仅 2 条。
- 语音文本由模型轮内生成，行为不可控：短文改写（正文重合率 0.66–0.92）、长文摘要（0.18–0.41），从不直接复用正文。
- 目标：短文（≤阈值）程序清洗原文直接朗读，0 额外 LLM 请求；长文（>阈值）后台异步摘要（prompt 只含正文，约 2k token），主轮不阻塞、摘要不背全上下文。

## Scope

做：

- 配置打平（固定 MiniMax）：`TtsOptions` 简化为扁平结构——`provider`/`apiBase`/`apiKey`/`model`/`speed`/`rpm`/`extraBody`/`voices`（多音色数组，可切换）/`defaultVoice`（选中 `voices[].id`）/`japaneseVoice`（兼容字段）/`threshold_chars`（默认 300）/`enabled`，不再依赖 `ttsPresets` 嵌套；内部 snake_case、配置 JSON 驼峰别名。`voices` 为空时兼容旧扁平（`defaultVoice`/`japaneseVoice` 直接是音色 id）。
- tts 从轮内工具调用改为 hook 后处理：`AgentHook.on_finally` 时机取最终正文，判定后生成语音。
- ≤阈值：程序清洗正文（去 Markdown 符号、只删动作/表情括号、路径/代码块压缩）→ `voice.submit`。
- >阈值：后台 `summarize`（复用 active memory 的 `schedule_background` + 无工具 `chat_with_retry`，system 上下文）→ `voice.submit`。
- 语音挂载与历史可见：hook 侧 `voice.submit` 返回 audio 写入 `request_context.attributes["voice"]`，复用现有落库链路（`_save_turn` 写到最后一条 assistant 消息 + outbound metadata 推送 + `_generate` 完成回写 durationMs）；历史与 WebUI 可见性等价现状（assistant 消息带 `voice` 字段，可重播）。
- 失败降级：摘要错误/超时 → 不生成语音，行为对齐 tts 生成错误（回复正文照常，语音静默跳过）。
- 更新 AGENTS.md 语音规则：模型不再生成 tts 文本，语音由程序自动附带。

不做：

- 不引入语音队列、重排或合并（长文语音晚于文字到达可接受）。
- 不改 `voice.submit` 合成通道与 MiniMax 配置。
- 不引入「是否朗读」的模型判断或复杂分类：hook 规则化（面向用户的非空正文默认朗读）。
- 阈值最优值不做调优实验，第一期只配置化（默认 300，数据支撑见 Risks）。
- 不修改 active memory 现有召回/摘要逻辑。

## Current Flow

1. 模型按 AGENTS.md「每轮最多一次，正文结束前触发」生成 `tts` 工具调用。
2. 实际输出模式：assistant `content` 空 + `tts` tool_call（116/120 次），其后正文轮（115/119 组配对）。
3. `TtsTool.submit` 后台合成并发送，桌面端流式播放。
4. 每轮输入 ≈ 2×上下文（`round_usages` 实测：`prompt=28059 + 28475`，上下文 28475）。

## Target Behavior

### 短文（正文 ≤ `threshold_chars`）

- 无假名：语音不再引入额外 LLM 请求——纯闲聊带语音轮整轮 `request_count=1`（现状 2），含其他工具的轮请求数不变（不因语音 +1）；hook `on_finally` 清洗 `final_content` → `voice.submit`，语音与文字几乎同时送达。
- 含假名：走后台 AI 打标（见中日分段），语音晚到，挂载用占位 audioId（同长文时序）。

### 朗读判定（统一播报）

- **不做轮次类型区分**：AI 回复结束后，正文非空且无异常（`context.exception` 为空）即播报——user / cron / heartbeat / system / subagent 轮一视同仁（subagent 轮正文不回推用户，无播放目标，天然无影响）。
- 唯一不播报：正文为空、异常轮（无有效回复正文可播）。
- heartbeat 现有 `DEFERRED_VOICE` 独立路径**停用**，统一由 hook 接管播报，防双语音。

### 长文（正文 > `threshold_chars`）

- 正文轮不阻塞；`on_finally` 只 `schedule_background`（fire-and-forget，`asyncio.create_task`），**不 await 摘要**——await 会让 `_save_turn` 落库与收尾被拖住。
- 无假名：后台摘要 → `voice.submit`；含假名：「摘要 + 打标」合并为一次后台调用（输出 ≤`threshold_chars` 带标签摘要）。
- 挂载用占位 audioId：`VoiceService.path(turn_id)` 是确定性 sha256，摘要前即可构造占位 audio（durationMs=0）写入 `attributes["voice"]`，落库正常进行；后台摘要完成后 `voice.submit` 同 turn_id 返回相同 audioId，合成后 `_generate` 按 audioId 回写 durationMs。
- 摘要输入只含正文+指令（约 2k token），不背对话历史。
- 总输入 ≈ 1×上下文 + 2k，远小于现状 2×上下文。
- 语音晚于文字到达（摘要 LLM + 合成耗时），桌面端流式播放需接受该顺序。

### 清洗规则

- Markdown：去 `#`、`**`、`` ` ``、表格转顿号列表、链接转文字；代码块跳过。
- 括号：只删动作/表情描述（摇尾巴、叹气类）；日期、数值、补充说明括号保留（实测 356 个括号几乎全为信息性，全删会丢「（913 MB）」「（10-17）」）。
- 路径/文件名/长清单：压缩为「已省略，共 N 项」；技术回复只读结论、变更、成败。
- 文本特征识别（代替轮级技术分类）：绝对路径前缀（`/nas/`、`~/.nanobot/` 等）、代码块围栏、URL、带扩展名的清单行——命中即压缩，任何轮次统一适用。

### 中日分段（假名触发 + AI 打标）

- 触发：假名（平假名 U+3040–U+309F、片假名 U+30A0–U+30FF）仅作**布尔检测**——清洗后文本含假名即触发 AI 打标；无假名直接按中文朗读（0 额外调用）。
- 不做正则扩展：一句话内中日混杂时字符级扩展边界不可靠，由 AI 语义打标（输入 = 清洗后文本，输出 = `[zh]...[/zh]`/`[ja]...[/ja]` 覆盖全部文本的等价内容）。
- 调用方式：后台（`schedule_background`），不阻塞；≤阈值含假名 = 一次打标调用，>阈值含假名 = 一次「摘要+打标」合并调用。
- 输出校验：AI 输出必须标签全覆盖（无未标注残留，provider 硬校验）；校验失败 → 不朗读（对齐摘要失败降级）。
- 配置依赖：仅当选中音色配置了日语（`voices[defaultVoice].languageVoices.ja`，或 `voices` 为空时的 `japaneseVoice` 字段）才走 AI 打标；未配置时含假名也按中文读（行为与现状一致）。

### 摘要 prompt

- 口语化，长度 ≤ `threshold_chars`（300 字内；现状 tts 中位 132 字、最大 328 字，300 安全）。
- 保留关键数字、结论、变更与需要介入事项。
- 保留鲸鱼娘口吻约束（与正文风格一致）。

### 失败降级

- 摘要错误/超时 → 不生成语音，行为对齐 tts 生成错误（`_generate` 失败 emit error 不朗读）：回复正文照常发送，语音静默跳过。
- 不播报仅限：正文为空、异常轮（`context.exception` 非空）——无有效回复正文可播；其余轮次统一播报。

### 语音挂载与历史

- hook 在 `on_finally` 内、`_save_turn` 前执行：`voice.submit(...)` 返回 audio → `current_request_context().attributes["voice"] = audio`。
- `_save_turn` 从 attributes 读到 voice 并写到本轮最后一条 assistant 消息（loop.py 现有逻辑），outbound metadata 同步携带，WebUI 实时可见。
- 合成完成后 `_generate` 按 audioId 反序匹配回写 `durationMs`，历史记录最终完整。
- 历史可见性等价现状：assistant 消息带 `voice` 字段（audioId/path/durationMs/provider/model），可重播；语音文本写入 `voice["text"]`（短文=清洗文本，长文=摘要文本），历史可直接查证朗读内容。

## Plan

- [ ] config：`TtsOptions` 打平（固定 MiniMax）——`provider`/`apiBase`/`apiKey`/`model`/`speed`/`rpm`/`extraBody`/`voices`（多音色）/`defaultVoice`/`japaneseVoice`（兼容）/`threshold_chars`（默认 300）/`enabled`（默认 true）；内部 snake_case、配置 JSON 驼峰别名。
- [ ] hook：新增语音后处理 hook，`on_finally` 读 `context.final_content`，按轮次类型与长度分支。
- [ ] 清洗模块：Markdown 正则 + 动作括号过滤 + 路径/代码块压缩 + 假名布尔检测（无扩展）+ AI 打标调用（后台，长文与摘要合并一次），单测覆盖样例。
- [ ] 摘要调度：复用 active memory 的 `schedule_background` + 无工具 `chat_with_retry`（system 上下文、temperature 0.1）。
- [ ] `voice.submit` 接入与 turn_id 传递：hook 侧取与 TtsTool 相同的轮次标识（`WEBUI_TURN_METADATA_KEY`/`turn_id`）；audio 写入 `request_context.attributes["voice"]`，依赖 `_save_turn` 自动落库与 `_generate` 回写。
- [ ] 删除模型侧语音工具（**按序**）：① 删除 `nanobot/agent/tools/tts.py` 及注册点（gateway_runtime import + `tools.register(TtsTool(...))`），模型不可再调用语音工具；② 删除 `DEFERRED_VOICE` 链路——voice.py 定义、gateway_runtime 的 set/reset 与 `if deferred_voice:` 消费逻辑（先停工具再删定义）；③ 清理 `tests/tools/test_voice.py` 中 TtsTool / DEFERRED_VOICE 相关测试（VoiceService 自身测试保留）。
- [ ] 停用后 heartbeat 轮语音由 hook 统一接管：turn_id（`heartbeat:{uuid}`）经 `WEBUI_TURN_METADATA_KEY` 传递，hook 取同一 turn_id 提交语音，播放/归位不受影响。
- [ ] AGENTS.md 语音规则改写。
- [ ] 测试：短文轮 `request_count=1`、长文不阻塞、清洗输出、摘要失败无语音、空正文/异常轮不播报。

## Apply Notes

- `on_finally` 在 `after_run` 后、run 的 finally 中执行，成功/失败都跑；成功轮 `context.final_content` 已带最终正文。
- 时序约束：`on_finally` 内**禁止 await 摘要/打标**；无假名短文 `voice.submit` 同步返回（内部 create_task），其余路径（长文摘要、含假名打标/摘要+打标）只 `schedule_background(... → voice.submit)`，均不阻塞 `_save_turn`。
- 后台挂载占位（长文、含假名短文）：构造 `audioId=sha256(turn_id)`、`durationMs=0` 的占位 audio 先写 `attributes["voice"]`，保证落库时消息已挂 voice；后台打标/摘要完成后 `voice.submit` 的 audioId 与占位一致，`_generate` 回写自动命中。
- 无假名短文挂载与现状一致：`voice.submit` 返回 durationMs=0 的 audio 写 `attributes["voice"]`，合成完成回写。
- turn_id 归属：`VoiceHook` 从 `request.metadata` 取 `WEBUI_TURN_METADATA_KEY`/`turn_id`，与现 TtsTool 同款逻辑；hook 侧必须拿到同一轮次标识，语音才能归位到刚发送的回复。
- 摘要调用不继承用户轮次路由上下文、不注册工具：`request_context(RequestContext(channel="system", ...))` + `llm_usage_source("system")`（active memory 模式）。
- 摘要 prompt 只含正文，不拼历史；输出校验非空，失败走降级。
- 括号过滤用白名单式动作/表情判定，不能按「括号一律删除」实现。
- 中日分段约束：假名只做布尔触发，不做字符扩展；AI 打标输出必须标签全覆盖（无未标注残留，provider 硬校验），校验失败不朗读；`[ja]` 段依赖 `japaneseVoice`，未配置时不做打标。
- 摘要失败不朗读：对齐 tts 合成失败行为，不引入清理逻辑（占位 voice 的残留行为与现状合成失败一致）；不设「截断兜底」朗读。
- 统一播报防双语音：`DEFERRED_VOICE` 整条链路删除（定义/生产者/消费者），heartbeat 轮正文改由 hook 播报；删除顺序：先停 TtsTool 再删 DEFERRED_VOICE。
- 彻底清理边界：模型侧语音工具整体删除（无兼容）；**保留**：`VoiceService`（hook 依赖，gateway_runtime 与 webui/ws_http 两处实例化）、`config.tools.tts` 配置（`threshold_chars`/`enabled` 加在这里、WebUI 设置面板沿用）、voice 合成/回写链路。
- heartbeat 轮 turn_id 链：`gateway_runtime` 以 `heartbeat:{uuid}` 作为 `WEBUI_TURN_METADATA_KEY`，hook 从 request metadata 取同一值提交语音，播放归位与现状一致。
- 配置已打平固定 MiniMax：`provider`/`apiBase`/`apiKey`/`model`/`speed`/`rpm`/`extraBody` 为 `tools.tts` 直接字段，`voices` 数组保留多音色（`languageVoices.default`/`.ja`），`defaultVoice` 指向选中 `voices[].id`；NAS 部署时把原 `ttsPresets[].config` 打平、`voices` 数组原样迁入，`japaneseVoice` 仅作 `voices` 为空时的旧扁平兼容（实测可解析）。
- 默认阈值 300（兼作摘要长度上限）：全量正文 ≤200 占 41.5%、201–400 占 32.5%、>400 占 26%（最近 50 条中位 271）。200 会让约 64% 走后台摘要，300 更均衡；配置可调，验证后微调。

## Verify

- [ ] 带语音且无其他工具的轮 `request_count=1`（`llm_usage` / `round_usages` 对比改动前 2）；含其他工具的轮请求数不因语音增加。
- [ ] 长文轮文字先发送、语音后到；`on_finally` 返回不被摘要拖住（落库延迟可忽略）。
- [ ] 清洗单测：Markdown 符号移除、动作括号删除、信息括号保留、路径压缩、假名触发检测、AI 打标输出全覆盖校验（含失败降级）。
- [ ] 含假名短文语音后到（后台打标）、无假名短文语音与文字同时；长文摘要+打标为一次调用。
- [ ] 摘要输出 ≤ `threshold_chars`，保留关键数字与结论（抽查样例）。
- [ ] 摘要失败不生成语音，回复正文照常发送（对齐 tts 生成错误）。
- [ ] 空正文 / 异常轮不播报；user / cron / heartbeat 轮统一播报（heartbeat 无双语音）。
- [ ] 历史与 WebUI：该轮 assistant 消息带 `voice` 字段（audioId/durationMs），可重播；合成完成后 durationMs 回写。
- [ ] AGENTS.md 与配置文档已同步。
- [ ] 无残留：grep `TtsTool` / `DEFERRED_VOICE` 在 `nanobot/` 与 `tests/` 无匹配（VoiceService 例外）。
- [ ] 扁平配置可解析：真实 `tools.tts`（apiKey/defaultVoice/japaneseVoice/thresholdChars）能被 `TtsOptions` 正确读取，`settings()` 不暴露 apiKey。

## Status

- State: doing
- Archived: no
