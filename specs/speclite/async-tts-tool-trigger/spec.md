# Spec: async-tts-tool-trigger

## Why
- `tts` 工具当前等待完整合成、WAV 落盘后才返回，阻塞 agent 继续生成回复。
- PCM 已流式下发播放；工具应只负责触发，完成后异步绑定历史。

## Scope
- 本次做：`agent` 模式下，`tts(text)` 提交后台合成后立即返回成功，不等待首包、完整音频或文件落盘。
- 本次做：后台任务继续发布 `start/chunk/end/error`，保持 Electron/桌宠流式播放链路。
- 本次做：合成成功后原子生成 WAV，并将语音元数据补写到对应 turn 的 assistant 历史消息。
- 本次做：兼容音频先于或晚于 assistant 消息落盘两种时序；每轮最多触发一次。
- 本次做：后台失败发布 `error`、清理临时文件且不写无效历史语音。
- 本次不做：修改 `always` 模式、TTS provider、PCM 协议、播放器、浏览器 WebUI。

## Plan
- [x] 为 `SpeechRuntime` 增加非阻塞提交入口，提交时同步占用 turn，后台执行现有流式合成。
- [x] `TtsTool.execute()` 改为提交即返回，区分参数/上下文拒绝与已接受的后台任务。
- [x] 建立 `turnId` 完成回调：assistant 已落盘时补写 `speech` 并保存 session，未落盘时暂存供 turn 保存阶段绑定。
- [x] 管理后台任务生命周期；完成、失败、取消时释放运行态并清理临时文件。
- [x] 补充立即返回、流事件不中断、前后两种落盘时序、重复触发和失败清理测试。

## Apply Notes
- “触发成功”只表示任务已接受；合成结果通过 `end/error` 事件表达，不回写第二条 tool result。
- 历史仍只保存稳定本地 `path` 与现有音频元数据，不保存 PCM、临时路径或签名 URL。
- turn 关联 use `session_key + turnId`；补写必须定位同一 assistant 消息，禁止生成独立历史消息。
- 复用现有 TTS runtime 和 AgentLoop 后台任务管理，不新增队列或抽象层。

## Verify
- [x] 慢 TTS provider 未产出首包时，`tts` 工具已返回“已触发”。
- [x] 工具返回后仍收到一次 `start`、多个有序 `chunk`、一次 `end`，播放不等待 WAV 完成。
- [x] 音频早于 assistant 落盘时，最终 assistant 历史包含 `speech`。
- [x] 音频晚于 assistant 落盘时，完成后同一历史消息补上 `speech`，重载历史可播放。
- [x] 同 turn 重复调用只启动一次合成；失败/取消发送 `error`，无临时文件和无效 `speech`。
- [x] TTS 相关 Python tests 通过，现有 `always` 模式行为不变。

## Status
- State: done
- Archived: yes
