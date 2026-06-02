## ADDED Requirements

### Requirement: 按需截图请求

服务端 SHALL 能够向指定 Electron 连接推送专用截图请求事件（`screenshot_request`，含唯一 `request_id`），且该请求与结果均不写入对话 transcript。

#### Scenario: 推送截图请求

- **WHEN** 主动陪伴编排需要目标端截图
- **THEN** 服务端 SHALL 向目标连接发送带唯一 `request_id` 的 `screenshot_request` 事件

#### Scenario: 不污染对话

- **WHEN** 发送 `screenshot_request` 或接收 `screenshot_result`
- **THEN** 系统 SHALL NOT 将其写入对话 transcript 或作为对话消息呈现

### Requirement: 客户端截图与 JPEG 压缩回传

Electron 客户端收到 `screenshot_request` 后 SHALL 采集桌面截图、压缩为 JPEG，并通过专用入站 envelope（`screenshot_result`，携带相同 `request_id` 与 JPEG data URL）回传。

#### Scenario: 截图并回传

- **WHEN** 客户端收到 `screenshot_request`
- **THEN** 客户端 SHALL 采集截图、压缩为 JPEG data URL，并发送携带同一 `request_id` 的 `screenshot_result`

#### Scenario: 压缩控制体积

- **WHEN** 客户端生成截图回传数据
- **THEN** 客户端 SHALL 通过降分辨率与 JPEG 质量将数据控制在服务端接受的体积上限内

### Requirement: 服务端接收并落盘截图

服务端收到 `screenshot_result` 后 SHALL 校验体积、解码 JPEG 并落盘到 media 目录，供后续 vision 输入使用。

#### Scenario: 解码落盘

- **WHEN** 服务端收到合法 `screenshot_result`
- **THEN** 系统 SHALL 解码并保存 JPEG 文件，关联到对应 `request_id`

#### Scenario: 超时未回传

- **WHEN** 在超时窗口内未收到匹配 `request_id` 的 `screenshot_result`
- **THEN** 系统 SHALL 视该次截图为不可用并通知编排降级处理
