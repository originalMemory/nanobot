# 代码组织哲学对比

[← 目录](./README.md)

| 主题 | nanobot | OpenClaw |
|------|---------|----------|
| 核心大小 | 刻意保持 loop/runner 可读 | 核心大但强调 extension-agnostic |
| 重复代码 | 允许通道/Provider 间重复，避免过早抽象 | 扩展内自包含；核心用 SDK 接缝 |
| 变更策略 | 最小改动、可审查 PR | 大仓库 + changed lanes + Testbox CI |
| 文档 | nanobot.wiki + 仓库 docs/ | docs.openclaw.ai + 庞大 docs/ |
| 分支 | main / nightly 双分支（CONTRIBUTING） | 高频迭代，严格 CI 矩阵 |

**下一步**：[功能矩阵](./feature-matrix.md)
