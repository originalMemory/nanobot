# Spec: codex-sse-server-error-retry

## Why
- Codex SSE `server_error` 被包装为普通 `RuntimeError`。
- 现有 1/2/4 秒重试因漏判而不触发。

## Scope
- Codex provider 将 SSE `server_error` 标记为可重试。
- 补自动重试回归测试。
- 不改 Electron，不增加重试按钮。

## Plan
- [x] 识别 `RuntimeError` 中的 `server_error`。
- [x] 写入结构化错误字段和 retry flag。
- [x] 验证首次失败后自动重试成功。

## Apply Notes
- 复用现有 `chat_with_retry`，不新增重试循环。
- 仅匹配 Codex provider 捕获的 `server_error` token。

## Verify
- [x] `server_error` 生成 `error_should_retry=True`。
- [x] 自动重试等待 1 秒后发起第二次请求。
- [x] 其他 Codex provider tests 通过。

## Status
- State: done
- Archived: yes
