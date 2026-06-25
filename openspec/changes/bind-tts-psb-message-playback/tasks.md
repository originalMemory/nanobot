## 1. Segment 数据模型与解析

- [x] 1.1 在服务端定义 assistant playback segment 类型，覆盖 `messageId`、`segmentIndex`、`rawText`、通用 `controls` 和 audio 状态
- [x] 1.2 在服务端出站流实现 segmenter，按句末、换行、`stream_end` 和 `turn_end` flush segment
- [x] 1.3 实现句首 PSB 标签解析，句中控制标签剥离并记录为 debug metadata
- [x] 1.4 为 segmenter 添加单元测试，覆盖日文标签、连续标签、句中标签、空朗读文本和跨 delta 边界

## 2. 聊天展示与调试视图

- [ ] 2.1 保持 assistant 气泡按 delta 连续流式渲染，并在渲染时过滤控制标签
- [ ] 2.2 添加每条 assistant 气泡的控制标签调试切换，展示 raw content 或 segment metadata
- [ ] 2.3 将旧 `showResponseTags` 语义改为控制标签调试显示，更新设置文案和 i18n
- [ ] 2.4 添加 UI 测试，验证默认不展示 PSB/TTS 控制标签、调试视图可查看 metadata，且 TTS segment 等待/播放不阻塞文字流

## 3. PSB Segment 生命周期

- [x] 3.1 用服务端推送的 playback segment 和 Electron `segment-start` / `segment-audio` / `segment-end` / `playback-stop` 事件替换 renderer 侧裸 tag 增量同步主路径
- [ ] 3.2 更新 Electron main / PSB manager IPC，将 segment lifecycle 事件有序投递给 PSB 窗口
- [x] 3.3 更新 PSB web runtime，在 segment start 执行动作，在 segment end 恢复 expression、face、fade
- [x] 3.4 保留非循环 timeline 自身结束后恢复初始循环 timeline 的行为
- [ ] 3.5 添加 PSB runtime 和 hook 测试，验证历史消息不触发、segment 顺序触发、segment 结束复位

## 4. 消息绑定 TTS

- [x] 4.1 添加消息绑定 TTS 设置，控制 assistant segment 是否自动进入 TTS 队列
- [x] 4.2 在服务端实现 segment TTS worker，按 `toSpeechText(segment)` 派生朗读文本后调用 provider，并把结果写回对应 segment
- [x] 4.3 支持并发合成和按 index 串行播放，后段先完成时等待前段，且相邻音频按 `end(N) -> start(N+1)` 切换
- [x] 4.4 支持停止生成、切换会话和刷新历史时取消或忽略过期 TTS 结果
- [ ] 4.5 添加 TTS worker 测试，覆盖空文本、provider 失败、取消、并发完成顺序

## 5. 音频播放与协议

- [x] 5.1 扩展 WebSocket playback segment 事件，传递 `messageId`、`segmentIndex`、controls、audio URL/MIME 和状态
- [x] 5.2 将 Electron 自动播放改为 segment 队列消费：PSB 窗口可用时由 PSB 播放，否则回退普通音频播放器，并在播放开始/结束时通知桌宠
- [x] 5.3 更新 PSB 音频口型同步，使口型绑定当前 segment 音频
- [x] 5.4 添加协议和播放队列测试，验证音频结果不会通过文本内容匹配归属，多段音频不会重叠播放，且切换时先触发上一段 end 再触发下一段 start

## 6. 旧路径清理

- [ ] 6.1 移除或降级独立 agent `tts` 工具的默认用户路径，更新工具发现和文档
- [ ] 6.2 清理旧的整条消息音频自动播放逻辑，避免与 segment playback 重复播放
- [x] 6.3 清理旧 PSB `stream-end` 主复位路径，仅保留迁移期兜底或删除
- [x] 6.4 更新 prompt 注入，要求 PSB 标签固定放在句首
- [ ] 6.5 删除旧测试 fixture 和过期 i18n 文案

## 7. 验证

- [ ] 7.1 运行 Electron 相关单元测试和组件测试
- [ ] 7.2 运行 Python webui / websocket / TTS provider 相关测试
- [ ] 7.3 手动验证一轮带多句 PSB 标签和 TTS 的 assistant 回复：正文干净且连续流式展示、多段音频顺序播放、动作开始/结束与音频切换对齐
- [ ] 7.4 手动验证停止生成、刷新历史、切换会话不会播放历史 segment 或残留桌宠状态

## 8. 后续 TODO

- [ ] 8.1 评估 THA 是否需要消费 assistant segment controls；一期不新增 Electron 通知服务端表情、动作或口型相关逻辑
