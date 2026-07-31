## Why

Dream 当前会信任可能过期或损坏的游标，并把模型自述当成审计内容；这会造成历史游标倒退、重复编号，以及提交记录与实际记忆文件变更不一致。需要吸收 0.3.0 的可靠性修复，让定时与手动 Dream 都以持久化事实为准。

## What Changes

- 历史游标只接受非负整数，并以游标计数器和现有历史中的最大值共同决定下一编号。
- Dream 游标只允许单调前进，损坏或负数游标安全回退。
- Dream 提示词加入当前持久记忆文件，使模型基于现状整理而不是盲写。
- 使用受控记忆文件的真实 Git diff 判断 Dream 是否产生有效变更，并据此生成提交审计摘要。
- 定时 Dream 与手动 `/dream` 使用一致的有效变更、游标推进和提交语义。
- 保持损坏 JSONL 行可跳过且警告受限，不改变 session 压缩、缓存或 Dream 调度策略。

## Capabilities

### New Capabilities

- `dream-memory-reliability`: 规定 Dream 历史游标、当前记忆注入、真实变更审计和执行入口的一致性。

### Modified Capabilities

无。

## Impact

- 后端：`nanobot/agent/memory.py`、`nanobot/utils/gitstore.py`
- 执行入口：定时 Dream CLI 与手动 `/dream`
- 测试：历史游标恢复、Dream 提示词、Git diff 摘要及两类执行入口
- 不新增依赖，不改变配置格式和前端接口
