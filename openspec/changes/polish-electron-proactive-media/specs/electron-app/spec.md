## ADDED Requirements

### Requirement: 首次动态壁纸同步

Electron 主进程 SHALL 在 WebUI renderer 注册壁纸 IPC 监听后，立即同步缓存壁纸；无缓存时 SHALL 触发一次抓取。

#### Scenario: 启动时已有缓存
- **WHEN** renderer 完成壁纸监听注册并读取配置，且主进程已有 `lastWallpaperDataUrl`
- **THEN** 主进程 SHALL 立即向 renderer 推送该缓存

#### Scenario: 启动时无缓存
- **WHEN** renderer 完成壁纸监听注册并读取配置，壁纸 URL 非空且主进程无缓存
- **THEN** 主进程 SHALL 立即触发一次壁纸抓取并把成功结果推送给 renderer

#### Scenario: 动态壁纸已禁用
- **WHEN** renderer 读取配置且壁纸 URL 为空
- **THEN** 主进程 SHALL 向 renderer 发送壁纸禁用事件
