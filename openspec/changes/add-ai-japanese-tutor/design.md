## 背景

nanobot 运行在 Unraid NAS，通过多个客户端连接；MBP 原生运行 Anki Desktop。现有运行时已经提供 workspace Skill、文件/exec、Cron、TTS、长期记忆和统一会话。当前 `japanese-tutor` 只是一组 Markdown 教学原则，缺少机器可读课程图、长期 planner、Anki 集成和主动复习。

目标内容横跨课程数据、AI 教学编排、Anki 服务和定时任务。实现应形成一个模块化 skill bundle，而不是把 104 课索引、脚本和全部规则塞进系统提示。Anki 负责 FSRS、Card 和 review history；AI 负责选课、生成材料、教学、纠错、mastery evidence 和确认后的制卡。

实际 NAS 初版已下载到 `/Users/illusion/Downloads/japanese-tutor`。该目录只作为一次性迁移输入；仓库内 `deploy/skills/japanese-tutor/` 是后续开发、测试和部署的唯一 canonical source，NAS workspace 是部署目标而不是开发源。

## 目标与非目标

**目标：**
- 从诊断起点循序推进到 JLPT N1，同时维护词汇/汉字、语法、阅读、听力、会话输出和考试策略六条能力轨。
- 以新标日 104 课为宏观骨架，使用 prerequisite 和 bridge node 修正机械课序。
- 默认提供 15～20 分钟课程；支持约 5 分钟 micro review 和用户明确要求的约 30 分钟 deep session。
- 在 MBP 原生运行 Anki Desktop + AnkiConnect，通过局域网 API 和 AnkiWeb 同步供 nanobot 与其他设备使用。
- 允许用户手工导入并直接使用三个个人新标日词汇牌组；不迁移、不改写原牌组，也不在项目中分发版权内容。
- 在不修改 nanobot core 的前提下，通过 Skill、脚本、现有工具和部署配置完成 MVP。
- 保留技能名 `japanese-tutor`，避免 workspace 覆盖规则、Cron prompt、学习档案和用户触发方式发生无收益迁移。

**非目标：**
- 不实现发音评分、ASR、forced alignment、F0 或 Electron/WebSocket 音频输入。
- 不复制或运行 `biaori-to-anki.js`，不解密官方 App，不分发教材词表、原声、课文或练习。
- 不在 nanobot 中重写 FSRS、Anki review UI 或同步协议。
- 不保证“完成课程节点”自动等于 JLPT N1 合格；官方题型只用于校准和分项反馈。

## 技术决策

### 1. 原地升级 `japanese-tutor`，不修改 agent loop

Bundle 计划结构：

```text
deploy/skills/japanese-tutor/
  SKILL.md
  references/
    teaching-loop.md
    correction-rubric.md
    anki-workflow.md
    sources.md
  data/
    curriculum-n1.yaml
    source-registry.yaml
  scripts/
    curriculum_state.py
    anki_adapter.py
    tts_media.py
  tests/
```

初版的 `SKILL.md`、纠错标准、课程原则、来源规则和学习档案约束先迁入 canonical bundle，再做增量改写。`SKILL.md` 只负责触发、按需读取和工具调用契约。104 课数据、来源和长规则不默认注入上下文。脚本通过 JSON stdout 返回机器结果，错误写 stderr 并使用非零 exit code；Downloads 快照不进入运行时搜索路径，也不作为测试 fixture。

替代方案是新增内置 `anki` Tool 和 planner subsystem；它会扩大核心 API、配置和测试面。现有 `exec`、文件、Cron 和 TTS 已能承载第一版，因此先不改 core。

### 2. YAML 保存静态课程，稀疏 JSON 保存运行状态

`curriculum-n1.yaml` 保存 104 课 node、bridge node、prerequisite、技能、来源和验证状态。PyYAML 已是项目依赖，便于人工审查。

运行状态保存为 `<workspace>/memory/japanese-learning-state.json`：
- learner profile 和目标；
- 六轨当前侧写；
- 仅保存已接触 node 的稀疏状态与 evidence；
- 当前 node、last session 和 next recommendation。

`curriculum_state.py` 负责 schema 校验、进程间文件锁和原子写入。`memory/japanese-learning.md` 继续作为短小的人类可读摘要，不保存 Anki due date 或完整 review history。首次升级时只把旧 Markdown 中明确记录的目标、偏好、错因和表现导入 JSON；旧文档中的“已掌握”不得在没有结构化 transfer evidence 时直接升级成 `mastered`。

### 3. Planner 以表现推进，不按日历灌课

标准 session 预算为 15～20 分钟：
- 0～5 分钟：最多 3～5 个当前实际可用的 Anki due/high-lapse 项；不足 3 个时不使用未到期卡凑数，没有 due item 时直接进入旧知识 transfer check 或新课；
- 7～10 分钟：一个新 curriculum node、两个例句和短对话；
- 3～5 分钟：transfer check、纠错、总结和卡片预览。

Micro session 约 5 分钟，只做 due review 或一道 transfer check。Deep session 约 30 分钟，可增加阅读或听力，但仍只增加一个主要新目标。

Node 状态为 `new → learning → reviewing → mastered`。只有跨至少两次会话、在新语境完成识别和主动输出，才能进入 `mastered`；失败允许降级。

### 4. AI 生成材料，但语言事实必须可追溯

`source-registry.yaml` 记录来源、版本、license、trust level、允许用途和 attribution。社区 JLPT 标签仅作 `community-estimate`。`candidate` curriculum node 不得用于正式教学。

材料生成后 use `SudachiPy + SudachiDict-core` 做确定性分词和 lemma 归一，输出结构化 lexical units：`surface`、`lemma`、`kind`、`known_reason`。覆盖率分母只包含词汇、汉字词和语法功能单位，排除标点、纯数字和已标记的专名。known set 来自已掌握 curriculum vocabulary、已确认的学习 evidence 和可映射的个人 Anki notes，当前 primary target 计为唯一允许的新单位。默认覆盖率低于 90% 时必须简化或重写；确实无法避免的专名或教学必需词要记录 exemption，不能静默通过。生成的例句、对话、阅读和听力稿记录 curriculum node、generator version、覆盖率明细和语言事实来源。

### 5. 六册 PDF 使用可恢复的两阶段视觉提取

课程事实优先来自用户本地 `D:\标准日本语` 下六册 PDF：初级上下、中级上下、高级上下，共 2362 页。PDF 可能是纯扫描版；流程不得依赖文本层，使用 Poppler 按页渲染，再调用本地 Ollama `qwen3.8:27b` 的 vision 能力。

提取分两阶段：

1. **页级提取**：每页独立输出严格 JSON，记录书册、PDF 页码、印刷页码、单元、课号、页面类型、栏目、显式知识点、语用限制、词汇主题、练习类型和不确定项。续页允许课号为空，不自行猜测。
2. **课程级合并**：按相邻页、页眉、课程起止页和目录信息聚合页面，补全续页归属，去重并生成 curriculum node；只保留抽象句型、规则、能力目标、易混点和来源页码，不复制连续教材正文、完整例句、练习或词表。

`extract_curriculum.py` 使用本地工作目录保存 manifest 和逐页结果。Manifest 记录 PDF 的路径、大小、修改时间、SHA-256、页数，以及模型、prompt 和 schema 版本。每页结果先写临时文件，校验 JSON 后原子替换；只有输入指纹和版本均一致的 `completed` 页面才跳过。中断后默认继续 pending/failed 页面，并支持按书册、页码范围、失败页或强制页重跑。默认并发为 1，避免 27B vision 模型争抢显存。

页级原始结果、渲染图片和可能包含教材原文的中间产物不得进入仓库。仓库只保存脚本、schema、无版权 payload 的测试 fixture，以及通过课程级合并和复核后的抽象 curriculum node。Qwen 初次输出统一标记为 `candidate`；课程边界合并、schema 校验和抽样人工复核后才可升级为 `cross_checked`。

### 6. Anki 是复习权威，AI 是课堂编排者

MBP 原生运行 Anki Desktop，AnkiConnect 绑定 MBP 局域网地址的 `8765`。当前部署由用户明确选择可信局域网模式，不设置 API key；adapter 仍支持从私密配置读取可选 key，未配置时不发送该字段。NAS nanobot adapter 使用 `http://<MBP-LAN-IP>:8765` 访问，不要求 Docker network。用户在 Anki GUI 中登录 AnkiWeb 并手工导入：
- `1939635284` 初级假名到释义；
- `1892756252` 中级假名到释义；
- `1899668880` 高级假名到释义。

`anki_adapter.py` 提供 `health`、`discover`、`due`、`card-info`、`review-history`、`answer`、`ensure-immersion-model`、`find`、`add-note`、`store-media` 和 `sync`。`due` 和 review 查询必须返回 card ID、note ID、deck、card type、due/lapse 信息以及可用的 curriculum node/candidate 映射。正式词汇复习由 AI 展示三个导入牌组中的到期卡，用户作答，AI 根据可观察证据自动提交前三档 rating：答错、放弃或看到答案后才会为 `Again`；请求/使用提示后答对，或在揭示答案前多次尝试并自行纠正为 `Hard`；无提示直接答对为 `Good`。`Easy` 只有用户明确表示“太简单/记 Easy”时提交。异步消息响应时间不得单独作为评分依据。adapter 通过 Anki scheduler 记 review，不直接写 rating、due、interval 或 revlog。

Anki 只决定哪些既有 Card 到期以及回答后的下一次间隔，不负责挑选新课内容。planner 依据 curriculum node 决定当前教材等级/课/单元，再调用 `lesson-vocabulary` 从三个牌组取候选词汇，结合频率、known set 和历史表现选出本课 3～8 个新词。

三个导入词汇牌组保持原样并作为词汇、单词音频、课程标签和 FSRS 状态的权威来源；adapter 只读取并通过 scheduler-backed `answer` 提交规则判定的评分，不新增字段、不改变 Note Type、不创建反向词汇卡。AI 需要主动表达练习时，可在课堂中临时反向提问，但不把它冒充为 Anki 中已记账的独立词汇 Card。

AI 生成的句子卡 mutation 先预览并获得明确确认，再取得跨进程 mutation lock 串行执行。每个候选生成稳定 `CandidateId` 并写入 Note 字段。音频使用 candidate ID 与内容 hash 生成确定性文件名；`anki_adapter` 从 nanobot workspace 读取音频 bytes，以 base64 `data` 调用 AnkiConnect `storeMediaFile`，不得把 nanobot 本地 path 传给 Anki 容器。随后按 `CandidateId` 查重并创建 Note，最后 sync。媒体成功但 Note 失败时允许以同名同 hash 重试；Note 已存在时重试不得重复创建。sync 失败返回 `written_unsynced`，后续只重试 sync，不得重放已成功 mutation。AnkiConnect 的 `multi` 不作为事务边界。

AI 生成句子写入“日语沉浸学习”牌组，使用 `Japanese Immersion` Note Type，可生成 Reading/Speaking Card；只有候选明确包含可用音频时才额外生成 Listening Card。该 Note Type 包含 `CandidateId`、`CurriculumNode`、`SourceRefs` 和生成器版本。个人词汇到 curriculum node 的映射只保存在 learner state 或 planner 输出中，不回写原牌组；无法映射时报告，不伪造映射。

Anki 和词汇复习不依赖 nanobot TTS。`tts_media.py` 只在用户确认“把 AI 生成句子做成带音频的听力卡”时调用，复用 nanobot 已配置的 OpenAI-compatible TTS provider 和固定日语 clone voice，把文本合成为 workspace 临时音频，并通过 JSON 返回 path、MIME、SHA-256、voice 和 generator metadata。它不走 turn-scoped `tts` tool，不向 stdout/stderr 输出 API key；`anki_adapter` base64 上传成功后清理临时文件。合成失败时仍可创建不带音频的 Reading/Speaking Card，但不得创建或声称存在 Listening Card。

### 7. 上课时由 AI 调 planner 与 Anki adapter

典型调用顺序：

```text
curriculum_state plan --duration 20
→ anki_adapter due/card-info/review-history
→ AI 生成并执行课堂
→ AI 按答题/提示证据自动判定 Again/Hard/Good；用户明确时可记 Easy
→ anki_adapter answer
→ curriculum_state record-evidence
→ AI 输出最多 3 条卡片预览
→ 用户确认
→ tts_media generate（用户确认需要句子音频时）
→ anki_adapter base64-store-media/add-note/sync
```

AI 不直接改 Anki SQLite、due 或 interval；只通过上述透明规则和 Anki scheduler 提交 review。用户可在课程开始时选择“只练习不记 Anki”或“手动评分”，此时 Card 保持原状态，界面必须明确说明没有记入 Anki review。AI 不在用户未确认句子卡候选时创建正式卡片。

### 8. 主动学习 use Cron，不 use Heartbeat 推进课程

Daily Cron 调 planner 和 Anki due：有 due 时发一道短题，否则仅预告 next node；用户回复后才展开课程，到期卡按同一自动评分规则记入 Anki。Weekly Cron 通过 adapter 的 review history 汇总六轨、node 和 lapse。Heartbeat 不推进 node、不记录 evidence、不创建卡片。

主动学习设置保存在 `<workspace>/memory/japanese-learning-settings.json`，包含 enabled、IANA timezone、daily/weekly schedule、quiet hours、new-lesson reminder 开关和最近一次成功提交日期；不新增 nanobot core 配置。quiet hours 内命中的任务直接跳过且不补发。每日上限按配置时区的本地日期计算；MVP 无 channel delivery receipt，因此 daily prompt 成功提交到 outbound bus 后即计数，生成失败或提交前失败不计数，weekly report 不占用 daily quota。

## 风险与取舍

- [104 课索引存在社区误差] → 每个 node 保存来源和验证状态；candidate 禁止进入正式教学，按级别分批审查。
- [AI 生成句子自然度不稳] → 限制一个新变量、要求来源可追溯、保留最小纠错与用户反馈回写。
- [MBP 休眠、离线或 Anki 退出] → adapter 返回明确不可用状态；课程跳过 Anki review，待 MBP 唤醒并启动 Anki 后恢复。
- [个人牌组含版权内容] → 只由用户手工导入，运行期留在个人 collection；仓库、镜像、fixture 和日志禁止携带内容。
- [AnkiConnect mutation 破坏导入词汇牌组] → 对三个词汇牌组只读查询，仅通过 Anki scheduler 提交透明规则判定的 rating；不迁移、不改模板、不回写字段。
- [Cron 与手动课程并发写状态或 Anki] → learner state 使用进程间文件锁和原子替换；Anki mutation 使用独立跨进程锁及稳定 CandidateId。
- [课程过大导致上下文膨胀] → SKILL 只路由；planner 每轮只返回相关 node 和少量来源，不加载完整 YAML。
- [Cron 打扰用户] → 默认关闭；配置固定时段、静默窗口和每日一次上限，无 due 时可保持安静。

## 迁移计划

1. 在 MBP 安装原生 Anki Desktop 和 AnkiConnect，验证 AnkiWeb sync、局域网 API 与 MBP 未休眠时的稳定连接。
2. 用户手工导入三个牌组；NAS 执行只读 discovery，核对 deck、字段、Note 数和媒体引用，不迁移牌组。
3. 实现可断点续跑的 PDF 页级提取器，在本地工作目录完成六册候选 JSON；先用初级上第 1 课做人工对照，再逐册慢跑。
4. 按课程合并候选结果，生成并复核 104 个抽象 curriculum node；逐页中间产物不进入仓库。
5. 在隔离 workspace 部署完整 skill bundle，先用 MBP 导入词汇牌组手动触发课程和 Anki review；通过端到端验证后生成 NAS 部署清单和 bundle checksum。
6. 用户备份 NAS 旧版 `<workspace>/skills/japanese-tutor/` 后显式覆盖；确认实际 NAS 行为后再启用 daily/weekly Cron。
7. 回滚时先停用 Cron，以备份的旧 Skill 目录恢复；Anki 词汇牌组从未迁移，可独立保留。

## 待确认问题

- MBP 的稳定局域网地址与休眠策略需在部署时确认。
- Daily/weekly Cron 的具体时间由用户在部署验收后配置。
- 日语克隆 voice ID 在部署时写入私密配置，不进入仓库。
