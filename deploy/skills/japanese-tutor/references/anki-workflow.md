# Anki 工作流

使用 `scripts/anki_adapter.py`，不要直接访问 Anki 数据库。默认从技能目录下已忽略的 `japanese-anki.private.json` 读取：

```json
{"url": "http://MBP-LAN-IP:8765"}
```

API key 可选；配置时使用 `apiKey`，不要在回复、日志或命令参数中输出它。Adapter 会绕过环境代理访问局域网。

- 正式课堂默认不访问 Anki。只有用户当次明确要求课堂联动 Anki 时才先运行 `health`；不可用时跳过 Anki 环节，不阻塞普通教学。
- 首次连接或牌组变化后运行 `discover`；它只报告结构、重复项和媒体异常，不输出卡片正文。
- `due --limit 5` 读取实际到期卡；不得用未到期卡补足数量。
- `card-info --card-id ID` 和 `review-history --card-id ID` 读取卡片及历史。
- 用户明确要求从 Anki 核对本课词表时，才用 `lesson-vocabulary --level beginner --lesson 1 [--unit 1]` 读取；默认课堂直接依据课程节点和教材页码控制范围。它不是要求 AI 逐卡教授的任务清单。
- 教材新词的首次学习与整课词汇复习由用户在Anki桌面／手机端完成，服从Anki自身排程。AI课程不得主动对教材新卡调用 `answer`，也不得用词卡覆盖率作为教材课完成门槛；`answer`只用于课前真实到期卡复习，且必须依据用户当次真实表现。
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

## 双向教材牌组

- 「假名到解释」训练读音／假名到词义的识别，应按当前教材课次优先学习；它的正面只显示假名，不等于完整的汉字阅读训练。
- 「解释到假名」训练中文释义到日文写法与读音的主动回忆，难度和复习成本更高；不应在学完整个初中高级识别牌组后再从头开始，也不默认要求全量双向。
- 推荐按课次分层：先完成当前课的「假名到解释」，再学习对应的「解释到假名」。第二方向会因第一方向刚激活记忆而更轻松，但是否长期全量双向学习仍以第 3～7 天的复习量和 Again 比例判断。用户目前已将两个初级方向牌组都设为每日 50 张新卡；中级、高级四个牌组新卡为 0，沉浸学习牌组为每日 10 张。正式课堂仍不默认读取或复习这些牌组。
