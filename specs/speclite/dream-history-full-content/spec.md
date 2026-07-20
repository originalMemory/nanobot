# Spec: dream-history-full-content

## Why
- 普通裁剪摘要落盘仅保留 8,000 字符，Dream 每条再截为 500 字符。
- Dream 固定每次读取 20 条，1M 上下文未被有效利用。

## Scope
- 本次要做：普通裁剪摘要使用现有 64,000 字符 emergency hard cap；Dream 一次完整读取全部未处理 history。
- 本次要做：保持一次裁剪对应一条 history 和一个 cursor。
- 本次不做：修改裁剪触发、`consolidationRatio`、Dream 周期、RAW fallback、`# Recent History`、空闲压缩。
- 本次不做：启用或清理 deprecated Dream 配置。

## Plan
- [x] 移除普通裁剪摘要的 8,000 字符专用上限，复用 `append_history()` 的 64,000 字符 hard cap。
- [x] 移除 Dream prompt 的 20 条批次限制和单条 500 字符裁剪。
- [x] 更新 Dream prompt、cursor 和 consolidator 落盘测试。

## Apply Notes
- Dream 继续使用当前 AgentLoop 模型和上下文上限。
- Dream 成功后 cursor 直接推进到全部未处理 history 的最后一条。
- 不拆分裁剪摘要，避免改变 `_last_summary` 和统一会话顶部上下文语义。
- 64,000 字符仅作异常回显保护，不新增动态分批逻辑。

## Verify
- [x] `pytest tests/agent/test_dream.py tests/agent/test_consolidator.py -q`
- [x] `ruff check nanobot/agent/memory.py tests/agent/test_dream.py tests/agent/test_consolidator.py`
- [x] 长 history entry 完整进入 Dream prompt，超过 20 条时全部进入且返回最后 cursor。
- [x] 普通裁剪摘要超过 8,000 字符时不再被截断，超过 64,000 字符时仍触发 hard cap。

## Status
- State: done
- Archived: yes
