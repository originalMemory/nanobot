# Spec: electron-webui-polish-followups

## Why
- Electron 迁移到 WebUI renderer 后，来源展示、主动通知、实时 usage 和滚动细节仍有缺口
- 零散视觉与 review 修复属于同一轮收尾，不需要拆成多份规范

## Scope
- 来源徽章对齐旧 Electron：渠道、主动推送、心跳/定时任务样式与 i18n
- AI 名称使用玫红色，定时任务使用紫色，主动推送保留琥珀色
- live `turn_end` 携带 usage，使流式结束后立即显示上下文占用
- WebSocket 重启通知在对应会话重连后补发，覆盖 `inbox:unified`
- 内容 resize 仅在原本贴底时继续贴底，不抢用户上翻或提示词顶部锚点
- assistant identity 使用 36px 头像和 16px 名称
- compose 恢复固定代理环境变量
- 删除误入的 `.codex/hooks.json` 和 Python 3.10 `Pipfile`
- 保留重启时本地提示与聊天通知双提示
- Unified Inbox 使用 `unified:default` 作为 workspace 与定时任务会话，不再生成
  `websocket:inbox:unified` 普通话题或 transcript

## Plan
- [x] 完善来源徽章样式、文案、测试和 compose 代理配置
- [x] 将 `ctx.turn_usage` 写入 `TurnDelivery` runtime event
- [x] 恢复 WebSocket pending reconnect message
- [x] 分离“用户阅读历史”与“保持贴底”状态并补 resize 回归测试
- [x] 调整 assistant identity 尺寸与样式断言
- [x] 删除误入工作区文件
- [x] 修正 Unified Inbox 的 workspace、transcript 与 cron session 路由

## Apply Notes
- 来源继续复用 channel plugin 名称、图标和品牌色；`heartbeat` 映射 i18n
- usage 与 latency 共用 runtime event 生命周期，Unified Inbox 按 `turn_id` 归属
- pending reconnect message 每个 `chat_id` 最多缓存 10 条，订阅 hydrate 后发送
- `stickToBottomRef` 记录贴底意图；`userReadingHistoryRef` 只表示用户主动阅读历史
- AI 开始输出后恢复自动贴底；发送后的提示词顶部锚点不视为贴底
- 代理值沿用个人 NAS 固定 IP，不做通用化
- 已存在的 `websocket:inbox:unified` 会话与 cron job 不做迁移，由部署时手动清理

## Verify
- [x] WebUI 来源、消息与 viewport 针对性测试通过
- [x] agent usage、restart manager 与 WebSocket reconnect 测试通过
- [x] WebUI 全量测试：50 files / 765 tests
- [x] WebUI lint、build 通过
- [x] Python lint 通过
- [x] compose YAML 与代理变量验证通过
- [x] `git diff --check` 通过
- [x] Unified Inbox 特殊路由回归测试通过（相关测试 74 项）

## Status
- State: done
- Archived: yes
