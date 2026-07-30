## Context

Electron 当前先把 reasoning/trace 聚成 Activity，再由 `coalesceAssistantTurnUnits` 将连续 Activity 与 assistant 正文收进 `AssistantTurnBubble`。该算法依赖相邻位置、`activitySegmentId`、`channelDelivery` 和全局 streaming 状态，没有稳定的轮次边界；中途正文、工具调用、主动推送和断线回放交错时容易误合并或遗漏。

upstream v0.3.0 已在 WebSocket 和 transcript 中提供 `turn_id`、`turn_phase`、`turn_seq`，并用 turn-aware Activity timeline 保留多条正文。Electron 仍保持独立 renderer，但可复用这套消息归属契约。

## Goals / Non-Goals

**Goals:**

- 让每条用户消息、Activity 和 assistant 正文具有明确的 turn 归属和顺序。
- 删除 `AssistantTurnBubble` 及其连续消息猜测逻辑，按原始多段消息展示。
- 同一 turn 的身份信息只出现在第一条 assistant 正文，footer/context/TTS 操作只出现在最后一条。
- 实时流、历史回放、Cron/Heartbeat 主动投递和恢复后的消息使用相同展示模型。
- 保留 Electron 独立 renderer 及现有动态壁纸、音频、TTS、统一会话和 Activity/File Diff。

**Non-Goals:**

- 不把 Electron 改为远端 WebUI 套壳。
- 不引入 root WebUI 的 Session 模型切换、分叉、新建会话或语音输入。
- 不把多段 assistant 正文重新拼接为一条消息。
- 不保留缺失 turn 元数据时的 Electron 旧聚合 fallback。

## Decisions

### 1. 采用 v0.3.0 的 turn 元数据作为唯一轮次边界

Electron 发送用户消息时生成 UUID `turn_id`；gateway 将它保存为 `webui_turn_id` metadata，并在同轮所有对外事件中附带 `turn_id`、`turn_phase`、`turn_seq`。主动投递由后端生成独立 turn id。

替代方案是继续用相邻用户消息划分轮次。该方案无法可靠处理没有用户消息的 Cron/Heartbeat，也不能区分迟到事件，因此不采用。

### 2. transcript 负责旧记录的轮次归属

Electron 不实现客户端兼容分支。历史记录统一经过 transcript replay；缺少持久化 turn 元数据的旧记录由 replay 按用户边界、主动投递边界和 `turn_end` 生成确定性的 synthetic turn id，再输出完整字段。

这样 Electron 只有一种数据模型，兼容复杂度留在已有的历史规范化入口。

### 3. 展示单位为原始 message 或 Activity，不再有 assistant-turn 气泡

时间线仅将 reasoning/trace/file edit 收为 Activity 单位，assistant 正文始终保持独立 message。每个单位按 `turnSeq` 排序；没有序号时保持 transcript/实时数组顺序。

`activitySegmentId` 只用于同一 turn 内划分多个 Activity 段，不再承担 turn 边界职责。

Activity 整体复用备份分支：`coalesceActivityMessages` 合并同一工具调用的 start/end、重复 trace 和附属 media/file edit；`ThinkingReasoningShell` 负责直播展开、历史折叠和完成后自动收起。这里的折叠层属于 Activity，不是已删除的 assistant 回复聚合气泡。

### 4. 身份和 footer 由 turn 中的位置决定

渲染前计算每个 turn 的首个 agent 展示单位，以及每条 assistant 正文是否为最后一条：

- 首个 agent 单位之前展示整轮 header（头像、名称和来源），因此 Activity 不会出现在头像上方。
- 最后一条展示时间、复制、TTS、token/context 和 turn latency。
- assistant 正文沿用备份分支的文档式布局，不再重复头像或额外套边框气泡。
- 中间正文只展示内容，保持紧凑间距。
- 整个对话视口使用统一半透明 surface，覆盖左右留白和底部输入区；不使用 backdrop blur，也不恢复逐消息 assistant 气泡。

主动投递即使没有用户消息也具有独立 turn，因此能够正常显示来源和 footer。

### 5. TTS 与音频仍按原始消息工作

消息不再合并后，每条正文保留自己的 playback segments；自动播放仍按现有队列顺序入队。可见的手动 TTS 操作仅放在 turn 最后一条，但不得改变已经生成的音频片段归属。

### 6. 流式状态按活动 turn id 收口

Hook 记录当前本地发送 turn id，并只将匹配 turn 的 delta、reasoning、trace、file edit 和 `turn_end` 更新到该轮。全局 `isStreaming` 仅表示是否存在当前活动轮次，不再用于把尾部任意 assistant 单位强制视为同一轮。

## Risks / Trade-offs

- [旧 transcript 没有 turn 字段] → replay 生成确定性 synthetic turn id，Electron 不承担兼容逻辑。
- [协议字段遗漏会造成消息无法归组] → gateway、transcript、Electron 类型和事件测试同时覆盖每类事件。
- [多段回复视觉上比单气泡更松散] → 同 turn 中间消息隐藏重复身份/footer并使用紧凑间距。
- [Activity 先于正文时身份顺序错位] → header 绑定到 turn 的首个 agent 单位，而非首条正文；Activity 折叠完整沿用备份分支。
- [TTS 从聚合气泡改回逐消息可能改变按钮位置] → 播放队列保持逐消息，手动操作归到 turn 最后一条。
- [移植整个 WebUI 时间线会带入无关功能] → 只移植纯数据归一化逻辑，Electron 组件和功能开关保持独立。

## Migration Plan

1. 同一提交补齐 gateway/transcript 和 Electron turn 元数据，避免协议与客户端版本错位。
2. 用 turn-aware timeline 替换旧聚合并删除 `AssistantTurnBubble`。
3. 验证实时多段回复、历史回放、工具交错、主动推送、断线恢复、TTS 和 footer。
4. 回滚时整体回滚该提交，不维持运行时双轨。

## Open Questions

无。用户已确认不需要临时 fallback。
