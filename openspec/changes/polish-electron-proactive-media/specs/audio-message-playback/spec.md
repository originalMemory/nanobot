## ADDED Requirements

### Requirement: WebUI 音频播放器简洁展示

WebUI SHALL 将可播放音频展示为原生音频控件，不附加卡片边框、半透明背景或可见文件名。

#### Scenario: 展示可播放音频
- **WHEN** 消息包含带签名 URL 的音频附件
- **THEN** WebUI SHALL 展示原生 `<audio controls>`，且外层无附件卡片边框和背景

#### Scenario: 音频文件名仅用于无障碍标签
- **WHEN** 音频附件包含文件名
- **THEN** 文件名 SHALL 可用于播放器的 `aria-label`，但 SHALL NOT 作为可见 caption 渲染

#### Scenario: 自动播放行为保持
- **WHEN** Electron 实时收到带音频的主动消息
- **THEN** 简洁播放器 SHALL 保持现有自动播放尝试
