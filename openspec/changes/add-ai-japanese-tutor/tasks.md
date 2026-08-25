## 1. MBP 原生 Anki

- [x] 1.1 在 MBP 安装官方 Anki Desktop，创建或选择专用 Profile，并验证 AnkiWeb 登录与第二设备同步。
- [x] 1.2 在 MBP 安装 AnkiConnect 插件 `2055492159`，设置 `webBindAddress: "0.0.0.0"` 与端口 `8765`；用户确认仅在可信局域网使用，当前不设置 API key。
- [ ] 1.3 从被忽略的私密配置加载 MBP 局域网 URL 和可选 AnkiConnect API key；key 未配置时 adapter 不发送该字段。让 NAS adapter 禁用环境代理或正确设置 `NO_PROXY`，并验证 nanobot 可通过局域网 `8765` 调用 AnkiConnect。
- [ ] 1.4 验证 MBP 唤醒且 Anki 运行时可访问；MBP 休眠、离线或 Anki 退出时，adapter 应返回可识别的不可用状态。
- [x] 1.5 记录三个 AnkiWeb 牌组 `1939635284`、`1892756252`、`1899668880` 的手工导入门；用户完成前停止后续真实牌组联调。

## 2. Anki Adapter 与个人词汇牌组

- [x] 2.1 实现 `anki_adapter.py` 传输层、可选 API key 处理、JSON 输出、错误 exit code、`health` 和 `sync`；配置 key 时确保日志不泄露密钥。
- [x] 2.2 实现只读 `discover`，报告匹配牌组、字段、标签、Note 数、重复项和媒体异常，不修改牌组。
- [x] 2.3 实现只读 `due`、`card-info`、`review-history`、`lesson-vocabulary`，按教材等级/课/单元返回词汇字段、Card/Note ID、音频引用、lapse 元数据和课程映射；实现 scheduler-backed `answer`。
- [x] 2.4 实现透明评分规则：错误/放弃/揭示答案后才会为 Again，使用提示或揭示前多次尝试后答对为 Hard，无提示直接答对为 Good，Easy 只由用户明确指定；支持整节只练习和手动评分模式，不用异步响应时间单独评分。
- [x] 2.5 使用 mock AnkiConnect 测试 health、discovery、due/history、四档评分、提示状态、只练习/手动模式、认证失败、畸形响应、代理绕过和网络失败。
- [x] 2.6 验证三个导入词汇牌组保持原 Note Type、字段、模板、Card、媒体和 FSRS 状态不变。
- [x] 2.7 定义 `Japanese Immersion` 字段、Reading/Speaking/Listening 模板、CSS、稳定 `CandidateId`、`CurriculumNode`、`SourceRefs`、生成器元数据和幂等 `ensure-immersion-model`。
- [x] 2.8 实现已确认句子卡的 `find`、`add-note`、跨进程 mutation lock、Candidate 对账和串行写入；sync 失败返回 `written_unsynced` 并支持只重试 sync。
- [x] 2.9 实现 adapter 读取 nanobot 临时音频 bytes 并以 base64 `data` 调用 `storeMediaFile`；禁止把 nanobot 本地 path 传给 Anki 容器。
- [x] 2.10 增加故障注入测试，证明媒体/Note 部分写入可幂等重试，sync 失败后不会重复 Note、媒体或重放 mutation。

## 3. 来源注册表与课程数据

- [x] 3.1 将 `/Users/illusion/Downloads/japanese-tutor` 一次性迁入仓库 `deploy/skills/japanese-tutor/`；保留技能名、人格边界、简单查词直答、纠错标准和来源谨慎原则，不保留 Downloads 运行或测试依赖。
- [x] 3.2 创建 `source-registry.yaml`，记录版本、URL、许可证、可信等级、允许用途和署名，并增加校验测试。
- [x] 3.3 定义 `curriculum-n1.yaml` schema：教材课号、主题、JLPT 估计、交际功能、语法、前置关系、近义对比、词汇选择器、技能、练习、来源和验证状态。
- [ ] 3.4 整理并交叉核验 48 个初级课程节点，不复制教材例句、练习、译文或音频。
- [ ] 3.5 整理并交叉核验 32 个中级课程节点，包含交际功能和篇章技能。
- [ ] 3.6 整理并交叉核验 24 个高级课程节点，包含语域、隐含态度、篇章结构和表达辨析。
- [ ] 3.7 增加 Foundation→N1 前置关系、桥接节点和 JLPT 官方题型覆盖元数据。
- [ ] 3.8 校验恰好 104 个教材 ID、唯一节点 ID、可解析前置引用、允许的验证状态、来源引用和无循环依赖。

## 4. 学习状态与 Teaching Planner

- [x] 4.1 定义稀疏 `japanese-learning-state.json` schema：学习者侧写、六轨 mastery、带会话 ID 的节点证据、已知词汇单位、当前节点、上一课堂和下一建议。
- [x] 4.2 实现 `curriculum_state.py` 跨进程锁、原子读写、schema 校验、摘要输出和畸形状态恢复。
- [x] 4.3 从现有 `memory/japanese-learning.md` 做一次保守导入；保留明确目标、偏好、错因和表现，但没有迁移证据时不得把旧“已掌握”直接变为结构化 mastered。
- [x] 4.4 实现首次诊断和六轨独立定级，不折叠成单一等级。
- [ ] 4.5 实现下一节点排序：前置关系、映射后的 Anki 弱项、教材课序、题型缺口、学习状态和桥接节点；定义 Anki 不可用或没有 verified 可教节点时的行为。
- [ ] 4.6 实现约 5、15～20、30 分钟的微型、标准、深度课程计划；不得为凑复习数量加入未到期卡。
- [ ] 4.7 实现 `new → learning → reviewing → mastered`，要求至少两个不同会话 ID 下的识别与主动输出证据后才 mastered。
- [ ] 4.8 增加 planner/state 测试：能力偏科、0～2 个到期卡、缺少前置、桥接返回、Anki 不可用、无可教节点、疲劳降级、mastery 降级、并发写和阶段 gate。

## 5. AI 课堂与材料工作流

- [ ] 5.1 重写教学参考为 plan → review → teach → practice → transfer → preview → record 闭环，并保留现有人格。
- [ ] 5.2 增加 `SudachiPy + SudachiDict-core` 材料分析依赖；实现结构化词汇单位、lemma 归一、已知集合匹配、声明式排除/豁免和默认不少于 90% 的实测覆盖率。
- [ ] 5.3 定义两个例句、2～4 轮对话、可选分级阅读、可选听力文本及来源/生成器元数据的 prompt/输出契约。
- [ ] 5.4 实现纠错与迁移证据记录，不把一次答对视为 mastered。
- [ ] 5.5 实现最多 3 个句子卡候选预览，并要求明确确认后才调用 Anki mutation。
- [ ] 5.6 实现可选 `tts_media.py`：只为用户确认的带音频 AI 句子卡调用现有 OpenAI-compatible TTS 和日语 clone voice；返回 path、MIME、SHA-256、voice 和生成器元数据，不泄露凭据。
- [ ] 5.7 TTS 失败时允许继续创建不带音频的 Reading/Speaking Card，但不得创建或声称存在 Listening Card。
- [ ] 5.8 更新人类可读 `memory/japanese-learning.md` 摘要，不复制 Anki due date 或 review history。

## 6. 主动学习

- [ ] 6.1 定义 `<workspace>/memory/japanese-learning-settings.json`：Daily/Weekly 开关与日程、IANA 时区、quiet hours、新课提醒、Cron job ID 和最近成功提交 Daily 提示日期，不增加 nanobot core 配置。
- [ ] 6.2 实现 Daily 入口：优先提交一道到期复习题，否则预告下一节点；用户回复前不开始完整课堂。
- [ ] 6.3 实现 Weekly 六轨/node/lapse 报告，不规定每周固定课数，也不占 Daily 配额。
- [ ] 6.4 实现 quiet hours 命中时跳过且不补发；Daily 提示提交 outbound bus 后才计入本地日期配额，提交前失败不计数。
- [ ] 6.5 验证 Heartbeat 不能推进节点、记录 mastery、创建卡片或启动正式课堂。

## 7. 验证与发布

- [ ] 7.1 扫描仓库和镜像，证明不含教材牌组 payload、音频、解密 key、导出 collection 或私密凭据。
- [ ] 7.2 运行标准课端到端：planner → Anki 到期词汇题 → 用户直接答对/提示后答对/答错 → AI 自动判定 Good/Hard/Again → Anki scheduler 更新 → 一个新目标 → transfer check；另验证只练习模式不写 review。
- [ ] 7.3 运行可选句子制卡端到端：候选预览 → 用户确认纯文本或音频 → 可选 TTS → base64 媒体写入 → Note 写入 → AnkiWeb sync → 第二设备复习。
- [ ] 7.4 验证媒体/Note 写入失败可重试、不调用 sync 且不报告成功。
- [ ] 7.5 验证本地写入成功后 sync 失败返回 `written_unsynced`、保留 Note ID，并在只重试 sync 时不产生重复 Card 或媒体。
- [ ] 7.6 验证重启后 Anki 数据、稀疏学习状态、当前节点、未解决错因、设置、Daily 配额和下一建议保持连续。
- [ ] 7.7 为 `deploy/skills/japanese-tutor/` 生成 manifest/checksum，在隔离 workspace 测试，并记录 NAS backup/copy/verify/rollback；实现阶段不得覆盖实际 NAS workspace。
- [ ] 7.8 用户部署 bundle 且 NAS 手动课堂验收通过后才启用 Daily/Weekly Cron，并记录禁用与回滚步骤。
