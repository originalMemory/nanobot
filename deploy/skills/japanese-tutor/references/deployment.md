# 部署、校验与回滚

本文件只描述命令，不自动覆盖 NAS workspace。

1. 在仓库运行 `bundle_manifest.py scan-repo --root <repo>`，确认没有提交私人配置或 Anki collection。
2. 在技能目录运行 `bundle_manifest.py create`，提交生成的 `bundle-manifest.json`。
3. 将技能复制到一个临时 workspace，运行 `validate_data.py`、`bundle_manifest.py verify` 和技能测试。
4. NAS 部署前把现有 `<workspace>/skills/japanese-tutor` 重命名为带日期的备份，再复制新 bundle。
5. 在 NAS 运行 `bundle_manifest.py verify`，然后手动执行状态、planner 和 TTS 占位检查；真实 Anki 验收另行进行。
6. 回滚时先禁用已创建的 Daily/Weekly Cron，移走新目录并把备份目录恢复原名。

`japanese-anki.private.json` 与 `japanese-tutor.private.json` 不进入 manifest；部署后在目标技能目录单独创建。
