## 图片理解

### Requirement: 图片直接交由当前模型理解
系统 SHALL 将用户图片和桌面截图直接传递给当前模型，不再调用独立的辅助视觉模型生成描述。

#### Scenario: 加载旧辅助视觉配置
- **WHEN** 配置中仍包含 `visionModel`、`visionProvider` 或 `visionEnabled`（包括 snake_case 形式）
- **THEN** 系统忽略这些字段，保存配置时不再输出它们

#### Scenario: 发送图片或获取桌面截图
- **WHEN** 用户发送图片，或 `desktop_context` 成功获取截图
- **THEN** 图片以图像内容块直接进入当前模型上下文

#### Scenario: 查看历史识图结果
- **WHEN** 用户查看包含旧图片描述的聊天历史
- **THEN** 客户端继续展示已有描述
