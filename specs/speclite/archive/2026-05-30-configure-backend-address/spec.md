# Spec: configure-backend-address

## Why
- 后端连不上时只有重试按钮，用户无法在 UI 中修改后端地址（默认 `http://127.0.0.1:8765`）
- 后端跑在非默认端口时，用户只能手动改配置文件

## Scope

本次要做：
- 在 `App.tsx` error 状态页增加后端地址输入框 + 「连接」按钮
- 点击「连接」时用新地址发起 bootstrap 验证，成功后：
  - 通过 `electronAPI.config.set("gateway.url", url)` 持久化到 electron-store
  - 切换到 ready 状态
- 失败时在页面内显示错误提示，不跳转
- 输入框预填当前 `state.gatewayUrl`
- 新增 i18n key（zh-CN + en）

本次不做：
- 在 Settings 页面增加后端地址管理
- 非 Electron 环境（纯 web）
- URL 格式校验（只做 bootstrap 验证）

## Plan

- [x] `App.tsx`：error 状态增加 `BackendAddressForm` 组件（地址输入框 + 连接按钮 + 错误提示）
- [x] `bootstrap.ts`：增加 `saveGatewayUrl(url)` 工具函数（写入 `electronAPI.config.set`）
- [x] `App.tsx`：`handleConnect` 调用 `bootstrapWithSecret` + 成功后 `saveGatewayUrl`
- [x] `i18n/locales/en/common.json`：新增 `app.error.backendAddress.*` key
- [x] `i18n/locales/zh-CN/common.json`：同上

## Apply Notes

- `bootstrapWithSecret` 已处理 success/error 状态切换，`BackendAddressForm` 只需在提交时调用它
- electron-store `gateway.url` 的读取逻辑在 `App.tsx` `useEffect` 里已有（`electronAPI.config.get("gateway")`），写入侧由本次补全
- 非 Electron 环境（`window.electronAPI` 不存在）时跳过持久化，仅调用 `bootstrapWithSecret`
- `saveGatewayUrl` 放在 `bootstrap.ts`，与 `saveSecret` 对称

## Verify

- [ ] 后端未启动时，error 页面显示地址输入框，预填默认地址
- [ ] 输入错误地址点连接 → 显示错误提示，不跳转
- [ ] 输入正确地址点连接 → 成功进入主界面
- [ ] 重启应用后，electron-store 中的地址被读取并自动连接

## Status
- State: done
- Archived: no
