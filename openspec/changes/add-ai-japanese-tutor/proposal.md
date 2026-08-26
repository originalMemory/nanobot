## 为什么

NAS 已部署名为 `japanese-tutor` 的初版 workspace Skill，包含教学提示、纠错规则、轻量课程说明、来源规则和 Markdown 学习档案，但无法自主规划从入门到 JLPT N1 的长期课程，也没有跨设备的可靠卡片、复习与主动提醒闭环。其下载快照位于 `/Users/illusion/Downloads/japanese-tutor`，仅作为本次迁移输入；实现产物必须进入仓库版本控制，不能依赖 Downloads 路径运行。nanobot 已运行在 NAS 并具备 Skill、TTS、Cron、记忆和 shell 能力，适合在不重写核心 agent loop 的前提下增加模块化日语教学能力。

## 变更内容

- 保留现有技能名 `japanese-tutor` 并原地升级为模块化 bundle；入口 Skill 保持短小，课程图、来源规则、教学策略、Anki adapter 和模板按需加载，同时保留初版的人格边界、简单查词直答和谨慎纠错原则。
- 新增标日初级 48、中级 32、高级 24 课的结构化索引，并建立 Foundation→N5→N1 prerequisite graph、bridge node、六轨 mastery 和阶段 gate。
- 使用用户本地 `D:\标准日本语` 下六册扫描 PDF，通过本地 Qwen3.8 27B 视觉模型做可断点续跑的逐页知识点提取，再按课程聚合；逐页 OCR/视觉结果留在本地工作目录，不把教材正文、练习、译文或图片提交到仓库。
- 新增 AI 教学规划器；每轮先复习 3～5 个到期弱项，再教授一个新目标，默认课程时长 15～20 分钟。
- 新增受 mastery 约束且可度量的材料生成：例句、短对话、分级阅读和听力练习；AI 生成句子只有在用户确认制作听力卡时才可选地合成 TTS 音频。
- 在 MBP 原生运行 Anki Desktop + AnkiConnect；NAS nanobot 通过局域网访问 MBP，继续使用 AnkiWeb 多设备同步。
- 支持用户手工导入三个新标日“假名到释义”个人牌组；AI 直接读取其中的词汇、课程标签、到期卡和复习历史，不迁移、不改写原牌组，也不在仓库或镜像中分发牌组及教材音频。
- 定义 daily review 与 weekly report 的教学内容，由 nanobot 现有 Cron 创建并按用户指定时间触发，不实现技能私有调度器。
- 将用户语音输入、ASR、forced alignment 和发音评分留作独立后续变更。

## 能力范围

### 新增能力
- `ai-japanese-curriculum`: N1 课程索引、来源治理、六轨 mastery、AI planner、材料生成、教学闭环与学习时长。
- `anki-learning-integration`: MBP 原生 Anki Desktop、AnkiConnect adapter、个人新标日牌组发现与复习、AI 句子卡、媒体与同步边界。
- `proactive-japanese-learning`: 复用 nanobot Cron 的 Daily/Weekly 教学内容、课程入口和跨会话连续性。

### 修改能力

无。

## 影响

- 部署：MBP 安装原生 Anki Desktop 和 AnkiConnect；AnkiConnect 仅通过可信局域网端口供 NAS nanobot 访问，API key 保留为可选配置。
- Skill：将下载的 NAS 初版迁移到仓库内 `deploy/skills/japanese-tutor/` 作为 canonical bundle，扩展 references、结构化课程数据、scripts 和 tests；验收后由用户显式部署到 NAS `<workspace>/skills/japanese-tutor/`，部署前备份旧版。
- 外部系统：Anki Desktop、AnkiConnect、AnkiWeb、现有 OpenAI-compatible TTS provider。
- 核心代码：MVP 不修改 nanobot agent loop、provider、WebSocket、Electron 或浏览器 WebUI。
- 后续范围：pronunciation/ASR 变更将修改 WebSocket/Electron 入站音频与独立声学分析服务，不属于本 change。
