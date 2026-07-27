# Spec: codex-summary-active-memory

## Why
- Codex reasoning summary 在 nanobot 中输出英文。
- Codex API 无 summary language 参数，需要在 request instructions 中约束。
- Active Memory 以 system message 注入，破坏主 prompt 和缓存前缀。
- `active_memory.jsonl` 无大小上限。

## Scope
- OpenAI Codex provider 前置中文可见输出指令。
- Active Memory 结果追加到当前 user message 尾部，并进入首轮 model request。
- `active_memory.jsonl` 按大小轮转。
- 补 provider、hook、日志轮转回归测试。
- 不改 reasoning effort、Electron、通用 system prompt。

## Plan
- [x] 增加 Codex 中文输出 instructions。
- [x] Active Memory use user reference block，不再追加 system message。
- [x] 调整 hook 时序，使 `before_iteration` 修改进入当前 request。
- [x] 日志达到 5 MiB 时移入 `memory/archive/`，按切分时间命名。
- [x] 更新相关测试。

## Apply Notes
- 约束覆盖最终回复和 reasoning summary。
- 中文约束只影响 `openai_codex` provider。
- Active Memory block 放在当前 user content 尾部，标记为 reference data。
- 当前文件固定为 `memory/active_memory.jsonl`。
- 历史文件命名为 `memory/archive/active_memory-YYYYMMDD-HHMMSS-ffffff.jsonl`，时间 use `Asia/Shanghai`。
- 5 MiB 仅作为当前文件切分阈值；历史分片数量和累计大小不设上限，不自动删除。

## Verify
- [x] Codex request `instructions` 以中文约束开头。
- [x] 原 system prompt 继续传入。
- [x] Active Memory 首轮可见，system prompt 不变。
- [x] Active Memory 位于当前 user message 尾部。
- [x] 日志越过 5 MiB 后移入 archive，文件名包含切分时间。
- [x] 多次切分不覆盖历史文件，不清理旧分片。
- [x] provider、runner、Active Memory tests 通过。

## Status
- State: done
- Archived: yes
