---
name: speclite
description: spec-first lite。轻量开发 spec，倾向轻量任务、开发中小改动时可以触发。
disable-model-invocation: true
---

# Speclite

轻量 spec-first 模式。**一个目录，一个 `spec.md`，先写清再动代码。**

## 何时使用

适用：small 改动、单模块增强、简单 bugfix、不想走 openspec 全流程但仍需 `apply`/`verify` gate。

不适用：跨 3 个以上独立模块、需要复杂方案对比或并行任务拆分。遇到这些情况，停止并切回 openspec。

## 产物路径

本项目默认目录：`specs/speclite`

写入：`specs/speclite/{change-name}/spec.md`（目录不存在时先创建）

## `spec.md` 模板

```markdown
# Spec: {change-name}

## Why
- 要解决什么问题
- 为什么现在做

## Scope
- 本次要做
- 本次不做

## Plan
- [ ] task 1
- [ ] task 2

## Apply Notes
- 只记录关键实现决策、约束、风险

## Verify
- [ ] 验证项 1
- [ ] 验证项 2

## Status
- State: draft
- Archived: no
```

## 执行规则

1. `Why` 和 `Scope` 用最少文字写清，不写空话
2. `Plan` 必须是可执行 todo
3. `Apply Notes` 只保留影响实现的要点
4. `Verify` 写可观察、可执行的验收项
5. 写完先让用户确认，再进入 `apply`

## 写作风格（生成 spec.md 时强制执行）

目标：减少 token，保留完整技术信息。

**删除：**
- 客套开场：您好/当然/好的/没问题/非常感谢
- 废话虚词：基本上/其实/可以说/总的来说/就是说
- 冗余确认：需要注意的是/值得一提的是/请注意
- Hedging：可能/也许/建议您考虑/您可以尝试
- 冗余结尾：希望这能帮助/如有问题欢迎继续提问

**保留（不修改）：**
- 代码块、行内代码、命令、文件路径
- 技术术语、库名、API 名
- 数字、版本号

**写法：** 片段句 OK，短同义词优先（修复→fix，使用→use）。模式：`[事物] [动作] [原因]`。

## `apply` / 继续前刷新 `spec.md`

**进入实现前必须重新读取当前 `spec.md`**，适用于：首次 apply、用户确认（"继续"/"apply"/"go"）、会话 resume 或上下文压缩后、中断后继续。

重读后确认：`Why` / `Scope` / `Plan` / `Apply Notes` / `Verify` / `Status` 是否与当前记忆一致。

出现以下任一情况，停止实现并向用户说明差异后请求确认：

- `Status.State` 不是 `approved`，且用户本轮没有明确确认进入 `apply`
- 最新 `Scope` / `Plan` / `Apply Notes` 与旧计划冲突
- 改动范围已超出 speclite 适用范围
- `Why` 或 `Scope` 仍含糊

"继续"= 重读最新 `spec.md` 后按当前状态推进，不复用旧计划。重读本身不改写 spec。

## 状态流转

| 阶段 | 写法 |
|------|------|
| 初稿 | `State: draft` |
| 用户确认后 | `State: approved` |
| 开始实现 | `State: doing` |
| 通过验证 | `State: done` + `Archived: yes` |

speclite 不生成 `proposal.md`、`tasks.md`、`design.md`、`delta`，也不移动目录归档。

## 常见错误

- `Apply Notes` 写成设计长文
- `Plan` 只有"完成开发"这类不可执行项
- 已跨模块仍硬塞进单文件
- `apply` / 继续 / resume 前没有重读 `spec.md`
- 完成后忘记更新 `Status`
