## Context

统一 Session 已持久化 `_channel_delivery`、`_cron_job_name` 和来源字段，回放也能转换为 UI 字段；缺失展示发生在 WebUI 轮次头分组。Electron 壁纸由主进程抓取并通过 IPC 推送，但首次推送可能早于 renderer 监听。音频播放器复用了带边框和标题的通用附件框。

## Goals / Non-Goals

**Goals:**

- 不改 Session/cron 数据格式，修正主动推送的前端轮次边界。
- 让 renderer 注册监听后必然收到一次当前壁纸。
- 保留音频播放和自动播放，仅移除额外视觉装饰。

**Non-Goals:**

- 不改变 heartbeat/cron 投递目标与调度逻辑。
- 不改变动态壁纸抓取周期与持久化配置。
- 不改变图片、视频和普通文件附件样式。

## Decisions

- 在 `assistantTurnHeaderMessages` 中把 assistant `channelDelivery` 消息视为新的独立 legacy 轮次。来源元数据已完整，无需再改后端 transcript。
- `wallpaper:get-config` 作为 renderer-ready 握手：监听注册后调用该接口，主进程优先补发缓存，没有缓存时触发抓取。保留现有可见性调度器。
- audio 分支直接渲染 `<audio>`，不进入 `AttachmentFrame`，并保留文件名仅作为无障碍标签。

## Risks / Trade-offs

- [同一主动轮次拆成多条 `_channel_delivery` 消息时会显示多个轮次头] → 当前持久化语义是一条主动 delivery 对应一条完整 assistant 消息，按记录拆分符合现状。
- [首次壁纸同步与调度抓取并发] → 复用 `wallpaperFetching` 去重，并优先补发缓存。
- [音频失去可见文件名] → 保留包含文件名的 `aria-label`。
