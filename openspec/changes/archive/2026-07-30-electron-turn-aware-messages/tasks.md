## 1. Turn 元数据协议

- [x] 1.1 Electron 发送消息时生成并传递 `turn_id`
- [x] 1.2 Gateway 将 turn metadata 注入同轮 WebSocket 事件与 transcript
- [x] 1.3 Transcript replay 为实时和旧历史输出 `turnId`、`turnPhase`、`turnSeq`

## 2. Electron 流式状态

- [x] 2.1 扩展 Electron 消息与事件类型并统一提取 turn fields
- [x] 2.2 按 `turnId` 合并 delta、reasoning、Activity、file edit 和 `turn_end`
- [x] 2.3 保持主动投递和 TTS/audio playback 的独立 turn 归属

## 3. Turn-aware 展示

- [x] 3.1 移植并适配纯数据 Activity timeline，删除相邻消息聚合算法
- [x] 3.2 删除 `AssistantTurnBubble`，按原始 assistant 消息与 Activity 单位展示
- [x] 3.3 同 turn 首条展示身份，末条展示 footer、usage/context 和轮次操作
- [x] 3.4 保持动态壁纸样式、紧凑间距和 Activity 折叠后的贴底行为
- [x] 3.5 按备份分支恢复 turn header → Activity → 文档式正文的整体布局
- [x] 3.6 完整恢复备份分支的 Activity 去重、折叠和自动收起
- [x] 3.7 给整个对话视口增加无模糊的统一半透明背景，不恢复逐消息 assistant 气泡

## 4. 验证

- [x] 4.1 覆盖多段回复、工具交错、并发/主动 turn 和历史 replay 测试
- [x] 4.2 覆盖身份、footer、TTS/audio、Activity 和滚动回归测试
- [x] 4.3 运行 Python 相关测试、Electron 全量测试、lint 和生产打包
  - Changed-source lint 无 error；仓库全量 ESLint 仍受既有 alias resolver / react-hooks 配置错误影响。
- [x] 4.4 Review 最终 diff，确认旧聚合与 fallback 已删除
- [x] 4.5 覆盖 Activity 在前时的身份顺序和无边框正文回归
- [x] 4.6 覆盖工具 start/end 去重、历史折叠、直播展开和完成后自动收起
- [x] 4.7 覆盖对话视口半透明 surface、透明输入区和 assistant 无边框正文

## 5. Review 回归修复

- [x] 5.1 Transcript replay 按 `turnId` / `streamId` 隔离流式分片
- [x] 5.2 连续 Cron、Heartbeat 等主动投递各自生成独立 legacy turn
- [x] 5.3 所有 Electron 可见回复路径携带 turn metadata
- [x] 5.4 恢复 File Diff 查看入口
- [x] 5.5 修正 TTS 分段测试类型并覆盖上述回归
