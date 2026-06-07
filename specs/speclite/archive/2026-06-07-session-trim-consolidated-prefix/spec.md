# Spec: session-trim-consolidated-prefix

## Why
- `file_cap` 顶到 2000 后每轮对话都会小批量 trim，archive 产生碎片记录
- `last_consolidated` 前缀已写入 `history.jsonl`，主 session 继续保留会增加 load/save 和 UI 回放成本
- `on_trim` 已恢复完整 JSON 备份，可安全移动已整合前缀到 archive

## Scope
- 本次要做
  - `enforce_file_cap` 触发时优先裁掉 `messages[:last_consolidated]`
  - 裁掉的 consolidated prefix 走 `on_trim`，不走 `on_archive`
  - 若裁掉 prefix 后仍超过 `FILE_MAX_MESSAGES`，继续用 `retain_recent_legal_suffix`
  - 更新/新增单元测试覆盖 prefix trim、fallback hard cap、`last_consolidated` reset
- 本次不做
  - 不改 `maybe_consolidate_by_tokens` 摘要策略
  - 不改 archive 文件格式
  - 不为 archive 增加查询 UI/API
  - 不修改根目录 `webui/`

## Plan
- [x] 重读当前 `enforce_file_cap` / `retain_recent_legal_suffix` / `loop.py` 接线
- [x] 在 `enforce_file_cap` 中先处理 consolidated prefix
- [x] 保留现有 hard-cap legal suffix 作为第二阶段
- [x] 补充测试：prefix 一次性裁剪、未整合尾部不 raw_archive、超限后继续 hard cap
- [x] 运行相关 session/archive 测试

## Apply Notes
- `on_trim` 接收所有物理裁掉的原始消息
- `on_archive` 只接收未整合且被物理裁掉的消息，避免重复写 `history.jsonl`
- prefix trim 后 `last_consolidated = 0`
- 触发条件仍是 `len(messages) > FILE_MAX_MESSAGES`，不在未超限时主动裁剪

## Verify
- [x] `last_consolidated > 0` 且消息数超限时，archive 收到完整 consolidated prefix
- [x] prefix 裁掉后，session 消息数显著下降，`last_consolidated == 0`
- [x] prefix 裁掉后仍超限时，最终消息数 `<= FILE_MAX_MESSAGES`
- [x] `on_archive` 不接收已 consolidated 消息
- [x] 现有 `retain_recent_legal_suffix` 边界测试通过

## Status
- State: done
- Archived: yes
