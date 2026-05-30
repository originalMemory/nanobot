## 1. 共享 UI Primitives 提取

- [x] 1.1 从 `SettingsView.tsx` 提取共享组件到 `electron/src/renderer/components/settings/shared/`：`SettingsRow`、`SettingsCard`、`SegmentedControl`、`ProviderPicker`、`StatusBadge`
- [x] 1.2 提取 `SettingsLayout.tsx`（侧边栏 nav + content 区域壳组件），接受 `sections`、`activeSection`、`onBack` props
- [x] 1.3 提取 `RestartBanner.tsx`：接受 `visible`、`onRestart` props，渲染重启提示条

## 2. Section 子面板组件

- [x] 2.1 移植 `OverviewSection.tsx`：系统总览卡片，点击跳转各 section
- [x] 2.2 移植 `AppearanceSection.tsx`：主题切换、语言选择器、本地 UI 偏好（density/activityMode/codeWrap/brandLogos）
- [x] 2.3 移植 `ModelsSection.tsx`：模型 preset picker + BYOK provider 配置（搜索、展开编辑 API key/base URL/api_type）+ 辅助视觉模型配置区块
- [x] 2.4 移植 `ImageSection.tsx`：图像生成开关、provider/model 选择、aspect ratio/size 配置
- [x] 2.5 移植 `WebSection.tsx`：Web search provider/credentials、max results、timeout、Jina reader
- [x] 2.6 移植 `AppsSection.tsx`：CLI apps catalog + MCP presets grid + custom MCP server 面板
- [x] 2.7 移植 `RuntimeSection.tsx`：bot identity（name/icon/timezone）编辑 + 系统信息只读展示
- [x] 2.8 移植 `AdvancedSection.tsx`：安全/集成信息只读展示

## 3. Electron 本地偏好持久化

- [x] 3.1 扩展 `AppConfig` 接口：新增 `appearance.language`（默认 `"en"`）、`appearance.preferences`（`{ density, activityMode, codeWrap, brandLogos }`）
- [x] 3.2 实现 `useElectronPreference<T>(key, defaultValue)` hook：mount 时从 IPC 读取、setValue 时 IPC 写入 + 本地乐观更新
- [x] 3.3 改造 `useTheme` hook：检测 Electron 环境时通过 `useElectronPreference("appearance.theme")` 读写，替代 localStorage
- [x] 3.4 改造 `LanguageSwitcher`：Electron 环境下将 locale 写入 `appearance.language`，启动时从 store 初始化 i18next

## 4. App 路由与侧边栏集成

- [x] 4.1 `App.tsx` 新增 `view: "settings"` 状态分支，渲染 `SettingsLayout` + 活动 section 组件
- [x] 4.2 激活 `InboxSidebar` 的 Settings 按钮：移除 `disabled`，绑定 `onOpenSettings` 回调
- [x] 4.3 实现 settings 页 back 导航：SettingsLayout header 返回按钮切换 view 为 inbox

## 5. 数据流与 Restart 集成

- [x] 5.1 settings 页 mount 时调用 `fetchSettings()` 加载完整 `SettingsPayload`，写入本地 state
- [x] 5.2 各 section 保存操作调用对应 API 端点，处理响应中的 `requires_restart` 标志
- [x] 5.3 实现 RestartBanner 逻辑：`requires_restart: true` 时显示，点击 Restart 通过 WebSocket 发送 `/restart`
- [x] 5.4 settings 变更后刷新数据：保存成功后重新更新本地 state

## 6. 辅助视觉模型配置（Vision Caption）

- [x] 6.1 `settings_api.py`：`get_settings()` 的 `agent` dict 加入 `vision_model`、`vision_provider`；`update_agent_settings()` 支持写入两字段
- [x] 6.2 修复 `schema.py`：为 `vision_model`/`vision_provider` 字段补充 camelCase `AliasChoices`，使 config.json 中的 `visionModel`/`visionProvider` 能被正确解析
- [x] 6.3 `types.ts`：`SettingsPayload.agent` 加 `vision_model?: string | null`、`vision_provider?: string | null`；`SettingsUpdate` 加对应字段；`api.ts` 透传新字段
- [x] 6.4 `ModelsSection.tsx`：在主模型区块下方新增「辅助视觉模型」`SettingsGroup`，提供 model 输入框 + provider 下拉，与主模型共用同一个保存动作
- [x] 6.5 i18n：在 `en/common.json` 和 `zh-CN/common.json` 中补充 `rows.visionModel`、`rows.visionProvider`、`help.visionModel`、`help.visionProvider` 翻译 key

## 7. 测试

- [ ] 7.1 为 `useElectronPreference` hook 编写单元测试（mock IPC）
- [ ] 7.2 为 SettingsLayout + section 路由切换编写渲染测试
- [ ] 7.3 为各 section 的 API 调用编写集成测试（mock fetch，验证请求参数）
- [ ] 7.4 验证 RestartBanner 在 `requires_restart` 场景下的显示/隐藏行为
