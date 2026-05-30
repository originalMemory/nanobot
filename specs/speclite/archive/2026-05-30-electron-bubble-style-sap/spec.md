# Spec: electron-bubble-style-sap

## Why
- Electron 客户端对话气泡风格偏"文档流"（AI 无边框），与 SAP 的 IM 风格差距大
- 统一为 SAP 式气泡：渐变用户泡、边框 AI 泡、始终头像、名字在上，提升沉浸感

## Scope
- 本次要做
  - 用户气泡：主色渐变背景 + 白字 + 右下尖角 `18px 18px 4px 18px`
  - AI 气泡：加边框容器（`border-border` + `shadow-sm`）+ 左下尖角 `18px 18px 18px 4px`
  - 头像：24px → 36px，底部对齐 → 顶部对齐
  - Bot 名字：从 footer 移到气泡上方
  - 行高 1.7 + letter-spacing 0.3px
- 本次不做
  - 打字光带动效（保留现有 TypingDots）
  - 群聊/多角色逻辑
  - MarkdownText 内部 prose 排版
  - TTS 控件

## Plan
- [x] 用户气泡 `bg-secondary/70` → `bg-gradient-to-br from-primary to-primary/80 text-primary-foreground`，圆角改 `rounded-[18px_18px_4px_18px]`，阴影 `chat-user-bubble`
- [x] AI 消息 `<MarkdownText>` 外层加气泡 div：`border border-border chat-ai-bubble rounded-[18px_18px_18px_4px] px-4 py-3`
- [x] 头像 `h-6 w-6` → `h-9 w-9`，列宽 `w-8` → `w-10`，对齐 `items-end` → `items-start`
- [x] botName 从 footer 移至气泡容器上方（`text-xs text-muted-foreground mb-1`）
- [x] 气泡内容区加 `[letter-spacing:0.3px]`（行高沿用外层 `--cjk-line-height`）
- [x] 自定义阴影类：`chat-user-bubble`（主色调阴影）和 `chat-ai-bubble`（含暗色模式适配）
- [x] ReasoningBubble 和 CaptionBubble 移入气泡内部渲染
- [x] 工具调用 AgentActivityCluster 折叠进回复气泡顶部（历史消息），实时流式保持独立展开
- [x] 暗色模式：用户气泡改用 `text-primary-foreground`，CaptionBubble 加 `inverted` prop

## Apply Notes
- 气泡样式主要在 `MessageBubble.tsx`，阴影在 `globals.css`
- 渐变用 Tailwind `from-primary to-primary/80`，跟随 shadcn CSS 变量；暗色阴影在 `.dark .chat-ai-bubble` 中覆写
- AI 气泡是在 MarkdownText 外层包 div，不动 MarkdownText 内部
- 工具调用折叠：`ThreadMessages.tsx` 新增 `single-with-activity` 单元类型与 `foldActivityIntoBubbles()` 函数，以 `activityBefore` ReactNode prop 传给 `MessageBubble`，避免循环 import
- 实时流式 cluster（`liveClusterIndex`）不折叠，保留展开交互

## Verify
- [x] 用户消息显示为主色渐变 + `primary-foreground` 字色 + 右下尖角
- [x] AI 消息有边框气泡 + 左下尖角 + SAP 风格微阴影
- [x] 头像 36px 圆形，与气泡顶部对齐
- [x] Bot 名字在气泡上方
- [x] ReasoningBubble（思考了）在 AI 气泡内部
- [x] CaptionBubble（图片识别结果）在用户气泡内部
- [x] 历史消息中工具调用折叠在回复气泡顶部，可展开查看
- [x] 暗色模式下渐变、边框、阴影视觉正常

## Status
- State: done
- Archived: yes
