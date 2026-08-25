# Anki 工作流

使用 `scripts/anki_adapter.py`，不要直接访问 Anki 数据库。默认从技能目录下已忽略的 `japanese-anki.private.json` 读取：

```json
{"url": "http://MBP-LAN-IP:8765"}
```

API key 可选；配置时使用 `apiKey`，不要在回复、日志或命令参数中输出它。Adapter 会绕过环境代理访问局域网。

- 正式课堂开始前运行 `health`；不可用时跳过 Anki 环节，不阻塞普通教学。
- 首次连接或牌组变化后运行 `discover`；它只报告结构、重复项和媒体异常，不输出卡片正文。
- `due --limit 5` 读取实际到期卡；不得用未到期卡补足数量。
- `card-info --card-id ID` 和 `review-history --card-id ID` 读取卡片及历史。
- `lesson-vocabulary --level beginner --lesson 1 [--unit 1]` 读取当前课词汇。
- `answer --card-id ID` 通过 scheduler 评分；自动模式必须提供 `--outcome`，按需附加 `--used-hint`、`--attempts`、`--answer-revealed` 或 `--explicit-easy`。
- 只练习使用 `--mode practice`；手动模式使用 `--mode manual`，用户给出评分后再传 `--rating again|hard|good|easy`。
- `sync` 会修改外部同步状态，只在课程流程明确需要时调用。

## 确认后的句子卡

先向用户预览候选；只有明确确认后才可执行：

1. `ensure-immersion-model --confirmed` 幂等创建 `Japanese Immersion` Note Type 和“日语沉浸学习”牌组；
2. 将候选 JSON 写入 workspace，执行 `add-note --candidate-file ... --workspace ... --confirmed`；
3. 可选音频通过候选的 `AudioPath` 指向 workspace 内文件，Adapter 读取 bytes 后 base64 上传；
4. 返回 `written_unsynced` 时只执行 `sync`，不要重放创建流程。

`find --candidate-id ...` 用稳定 CandidateId 对账。禁止把三个新标日词汇牌组作为 `add-note` 的目标。

不要根据异步消息间隔评分。错误、放弃或揭示答案后才答对记 Again；提示后或多次尝试答对记 Hard；无提示直接答对记 Good；Easy 只响应用户明确选择。
