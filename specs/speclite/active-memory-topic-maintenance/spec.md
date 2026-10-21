# Spec: active-memory-topic-maintenance

## Why

- 主题卡后台最重成本花在注定被拒的泛化词上：`active_memory.jsonl` 新版段 source_count TOP12 全是「本/中午/webp/味道/号/公司/运动/小说/游戏」等泛化词且 100% no_save（3282/1435/864/786… 文件指纹 + 主模型判定全部白烧）。
- 单字词漏网进注入关键词：日志出现 60+ 个单字（第×9、号×7、B×6、课×5…），大多无检索价值。
- 主题卡即时更新导致高频主题一天多次全量重建（鸣潮 8/16~9/11 共 193 次 updated，单次 49~80s）；后台任务 p50=35s、p95=157s、max=597s，且与用户对话抢主模型（Codex 403/超时 26+ 次）。

## Scope

本次做：
- 泛化词/结构词预筛：主题卡送审前拦截（不计算 fingerprint、不送主模型判定），直接按 no_save 处理并记录跳过原因。
- 单字词过滤：`_validate_keywords` 对 len==1 且不在主题卡 known 名称（topic/aliases/related_entities）内的词拒绝。
- 主题卡改「dirty 标记 + 定时批量」：命中/新建候选只写 dirty 标记，不再即时调度；提供批处理入口，由 cron 每天定时逐个处理。

本次不做：
- 增量更新（全量重建保留，频率降到每天一次）
- `OLLAMA_TIMEOUT`（保持 6s，不挤占回复时间）
- no_save 长期缓存（fingerprint 外按主题名缓存）
- 注入预算分层（召回信息全优先，不做体积裁剪）
- 召回评估集构建

## Plan

- [ ] `_validate_keywords` 增加单字拒绝：len==1 且不在 `known` 名称集合 → rejected。
- [ ] 增加泛化词预筛：从现有主题卡决策日志提炼泛化词表（本/中午/味道/公司/运动/小说/游戏/号/webp/百度/pc 等），匹配即跳过主题卡环节（记录 `prefiltered_generic`）。
- [ ] dirty 队列：`active_memory_topics/dirty/<key>.json` 记录 topic+fingerprint+时间戳；`_maybe_schedule_topic_card` 改为只写 dirty 不调度。
- [ ] 批处理入口：遍历 dirty 队列快照，逐个复用现有 `_schedule_topic_card` 判定/建卡逻辑，完成后清理对应 dirty 标记。
- [ ] cron 定时任务：每天固定时间调用批处理入口（沿用现有 fingerprint/cooldown/single_flight 防重与防过期证据机制）。
- [ ] 回归测试：单字过滤、预筛跳过、dirty 队列、批处理幂等。
- [ ] ruff + 相关测试 + `git diff --check`。

## Apply Notes

- 预筛词表先内置常量，后续可由 no_save 决策统计自动扩充；预筛跳过仍写日志（`prefiltered_generic` + topic），便于评估误杀。
- dirty 队列与现有 `_topic_tasks` single_flight 去重并行：定时批量内同一 key 只跑一次。
- 批处理运行期间来源可能变化：沿用 `source_changed_before_generation` / fingerprint 校验，变化即跳过该次。
- 定时批量期间注入使用旧卡 + `_stale` 过期提示，不阻断召回路径。
- 注入不做预算裁剪：召回信息完整优先，注入体量维持现状（恒满 10 条）。
- 实现偏差（review 修正）：原计划「cron 定时任务」落地为**懒触发批量**——写 dirty 后由 `_maybe_trigger_batch()` 检查「dirty 非空 + 距上次批量 ≥ 24h（`maintenance.stamp`）」才调度一次单次批处理；不注册常驻定时器（`schedule_background` 的 shutdown gather 不 cancel 任务，无限循环会挂起退出）。语义等价「每天至少一次、跟随对话频率」。

## Verify

- [ ] 单字词（第/号/点/月…）不再进入注入关键词；已知单字实体（焰等）仍保留。
- [ ] 泛化词不再触发 fingerprint 计算与主模型判定，日志出现 `prefiltered_generic`。
- [ ] 命中/新建主题卡不再即时启动后台任务，只落 dirty 标记。
- [ ] 批处理按 dirty 快照逐个处理并清理标记；重复调用幂等。
- [ ] Active Memory 相关测试通过，ruff + `git diff --check` 通过。

## Status

- State: done
- Archived: yes
