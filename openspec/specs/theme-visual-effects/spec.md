## ADDED Requirements

### Requirement: Rainbow 主题全息背景效果
当 `data-theme="rainbow"` 激活时，`body` SHALL 应用多层径向渐变背景（固定定位），营造全息棱镜效果。渐变色包含紫/粉/橙/蓝等光谱色，透明度低（约 0.1）以不干扰内容可读性。

#### Scenario: Rainbow 主题 body 背景可见
- **WHEN** `data-theme="rainbow"` 被设置
- **THEN** `body` 元素具有 `background-attachment: fixed` 的多层径向渐变
- **AND** 背景色彩随页面位置呈现不同的微妙色调
- **AND** 前景内容保持完全可读

#### Scenario: 其他主题不受 rainbow 背景影响
- **WHEN** `data-theme` 不为 `"rainbow"`
- **THEN** `body` 背景由标准 `bg-background` token 控制
- **AND** 无额外渐变叠加

### Requirement: Rainbow 主题彩虹滚动条
当 `data-theme="rainbow"` 激活时，`webkit-scrollbar-thumb` SHALL 应用从紫到橙的线性渐变色。

#### Scenario: 滚动条呈现彩虹渐变
- **WHEN** `data-theme="rainbow"` 且页面可滚动
- **THEN** 滚动条滑块呈现 `linear-gradient(to bottom, #845ec2, #ff9671)` 渐变

### Requirement: Neon 主题发光阴影效果
当 `data-theme="neon"` 激活时，卡片和气泡元素 SHALL 具有荧光发光阴影效果（多层 box-shadow，包含品红和紫色调 glow）。

#### Scenario: Neon 主题卡片发光
- **WHEN** `data-theme="neon"` 且页面包含卡片元素（`.chat-ai-bubble` 等）
- **THEN** 卡片具有带颜色的多层 box-shadow
- **AND** 阴影颜色与 neon 主题主色（品红/紫）呼应

#### Scenario: Neon 主题输入框聚焦发光
- **WHEN** `data-theme="neon"` 且输入框获得焦点
- **THEN** `--ring` token 产生的 focus ring 呈现荧光色

### Requirement: Ink 主题宣纸纹理
当 `data-theme="ink"` 激活时，页面背景 SHALL 叠加一层极淡的网格纹理（模拟宣纸效果），通过 CSS `background-image` 的 `linear-gradient` 实现。

#### Scenario: Ink 主题宣纸纹理可见
- **WHEN** `data-theme="ink"` 被设置
- **THEN** 页面背景有细微的网格线纹理叠加
- **AND** 纹理透明度极低（约 2%），不影响内容可读性

#### Scenario: Ink 主题纹理不覆盖卡片
- **WHEN** `data-theme="ink"` 且页面包含 card 元素
- **THEN** card 元素的 `bg-card` 背景为实色，不透出纹理

### Requirement: Marshmallow 主题柔光效果
当 `data-theme="marshmallow"` 激活时，卡片阴影 SHALL 使用粉色/水蓝色调的柔和弥散阴影，区别于默认的灰色阴影。

#### Scenario: Marshmallow 主题卡片阴影柔和
- **WHEN** `data-theme="marshmallow"`
- **THEN** `.chat-ai-bubble` 的 box-shadow 包含 `rgba(245, 165, 195, 0.2)` 等粉色调阴影
- **AND** 整体视觉呈现柔和、温暖的氛围

### Requirement: 全局主题切换过渡动画
当主题从一个切换到另一个时，`background-color`、`color`、`border-color`、`box-shadow` 等属性 SHALL 以统一的过渡动画平滑变化，而非瞬间跳变。

#### Scenario: 主题切换无闪烁
- **WHEN** 用户从 "light" 切换到 "dark"
- **THEN** 背景色在 `--transition-duration`（0.3s）内平滑过渡
- **AND** 文字色同步渐变
- **AND** 过渡曲线为 `--transition-function`（cubic-bezier(0.4, 0, 0.2, 1)）

#### Scenario: 首次加载不触发过渡
- **WHEN** 应用首次启动加载主题
- **THEN** 不应出现从默认色到目标主题色的过渡动画
- **AND** 直接以目标主题渲染
