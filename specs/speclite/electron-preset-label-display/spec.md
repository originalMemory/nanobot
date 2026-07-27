# Spec: electron-preset-label-display

## Why
- Electron 模型选择器主标题展示模型 ID，preset `label` 未承担展示名职责。

## Scope
- Electron 设置页和聊天输入框优先展示 preset `label`。
- 模型 ID 保留为副标题或 tooltip。
- 不修改浏览器 `webui/`、后端 payload 或配置结构。

## Plan
- [x] 调整 Electron preset 展示逻辑。
- [x] 增加 label 优先与 model fallback 回归测试。

## Apply Notes
- 选择值仍使用 preset `name`，不改变模型路由。
- 空 label 回退到 `model`。
- 全量 TypeScript 检查仍被仓库已有的 PSB、TTS、App 等类型错误阻塞，本次改动文件未出现在报错中。

## Verify
- [x] 设置页选择器主标题优先显示 label。
- [x] 聊天输入框及下拉主标题优先显示 label。
- [x] Electron 针对性回归测试通过。
- [x] 改动文件 ESLint 检查通过。
- [ ] Electron 全量 TypeScript 检查通过（存在与本次改动无关的既有错误）。

## Status
- State: done
- Archived: yes
