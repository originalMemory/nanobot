# Spec: electron-gateway-auth-persistence

## Why
- Electron 只持久化 Gateway URL；`gateway.token` 无回写链路，重启后可能重复验证。
- 认证页无法修改 Gateway URL；启动命令也无法覆盖保存地址。
- Electron 切换到 WebUI renderer 后丢失 AI 头像、昵称和回复来源展示。

## Scope
- 本次要做：Electron 按 Gateway origin 持久化 `tokenIssueSecret`，成功验证后保存，退出登录时清除。
- 本次要做：认证页显示当前 Gateway URL；地址变化时连同密钥切换并重载。
- 本次要做：支持 `--gateway-url` 和 `NANOBOT_GATEWAY_URL`，优先级为 CLI、环境变量、本地配置、默认地址。
- 本次要做：Gateway origin 变化时禁止复用旧密钥。
- 本次要做：Electron 每轮 AI 回复只在首个展示单元显示配置中的头像、昵称及现有消息来源字段。
- 本次不做：持久化短期 WebSocket/API token；修改 Gateway 后端认证协议；改浏览器 WebUI 的同源连接方式。
- 本次不做：恢复旧 Electron 的 AI 回复聚合或消息转换。

## Plan
- [x] 扩展 Electron gateway 配置解析、origin 绑定密钥和启动覆盖。
- [x] 扩展 preload bridge，支持保存/清除密钥及认证页原子切换连接。
- [x] WebUI 成功验证、失败验证、退出登录时同步 Electron 密钥。
- [x] Native 认证页增加 Gateway URL 输入和切换连接逻辑。
- [x] Native AI 回复按 turn 边界接入 Bot identity，并只在首个展示单元显示头像、昵称和来源。
- [x] 补 Electron/WebUI 行为测试和中英文文案。

## Apply Notes
- 短期 `token`、`api_token` 继续只放内存并自动刷新。
- 持久化密钥绑定精确 `scheme://host:port`；CLI/env 覆盖到其他 origin 时不注入旧密钥。
- 浏览器 WebUI 不展示 Gateway URL 输入。
- URL 与密钥切换由单个 IPC 完成，避免 reload 竞态。
- Bot identity 直接使用 settings payload 的 `bot_name`、`bot_icon`、`bot_avatar_url`。
- 消息来源复用 `UIMessage.sourceChannel`、cron 和主动投递字段，不增加后端转换。
- AI 头像、昵称行只在 Native surface 恢复；浏览器 WebUI 保持官方布局。
- 同一 `turnId` 的 activity、推理和正文共用一条 identity header；旧历史缺少 `turnId` 时以相邻 user message 为轮次边界。
- 来源取本轮首个带来源字段的消息；后续展示单元不重复头像、昵称和来源。

## Verify
- [x] 相同 Gateway 重启 Electron 后自动换取短期 token，不再弹验证。
- [x] 修改 Gateway 后旧 origin 密钥不发送到新 origin。
- [x] 认证页可一次提交 Gateway URL 与密钥并连接。
- [x] `--gateway-url` 优先于 `NANOBOT_GATEWAY_URL`，后者优先于保存地址。
- [x] Native 每轮 AI 回复只显示一次头像、昵称和来源；流式、历史回放及缺少 `turnId` 的旧历史表现一致。
- [x] 浏览器 WebUI 不新增 AI 头像和昵称，不恢复回复聚合。
- [x] Electron test/typecheck/lint 和相关 WebUI test/lint/build 通过。

## Verification Evidence
- `cd electron && npm test && npm run typecheck && npm run lint`：pass，2 files / 14 tests。
- `cd electron && npm run package`：pass，生成 macOS arm64 包。
- `cd webui && npm test -- --run`：pass，49 files / 750 tests。
- `cd webui && npm run lint && npm run build`：pass；仅保留 Vite chunk size warning。
- Native identity 定向测试：pass，25 tests；覆盖流式 turn、历史 turn、缺少 `turnId` 和浏览器默认布局。
- Native auth 定向测试：pass，41 tests；覆盖 URL + secret 原子提交和失效密钥清除。
- i18n parity：pass，13 tests。
- `git diff --check`：pass。

## Status
- State: done
- Archived: yes
