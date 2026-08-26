# 六册 PDF 断点提取

脚本：`scripts/extract_curriculum.py`。默认读取 `D:\标准日本语`，结果写入 `D:\标准日本语\.nanobot-extract`。逐页 JSON、manifest 和可选渲染图只保存在本地，不提交仓库。

```powershell
# 扫描六册并建立 manifest
python skills/japanese-tutor/scripts/extract_curriculum.py scan

# 试跑：初级上第 1 单元总览和第 1 课
python skills/japanese-tutor/scripts/extract_curriculum.py extract --book beginner-up --from-page 37 --to-page 47

# 高级上代表页试跑（单元、正文、生词、讲解、练习）
python skills/japanese-tutor/scripts/extract_curriculum.py extract --book advanced-up --force-page 19 --force-page 20 --force-page 21 --force-page 22 --force-page 24 --force-page 25 --force-page 33 --force-page 37

# 中级上代表页试跑（单元、会话、生词、语法表达、阅读、练习）
python skills/japanese-tutor/scripts/extract_curriculum.py extract --book intermediate-up --force-page 25 --force-page 26 --force-page 27 --force-page 28 --force-page 33 --force-page 34 --force-page 36 --force-page 38 --force-page 42 --force-page 43 --force-page 45

# 查看进度
python skills/japanese-tutor/scripts/extract_curriculum.py status

# 继续全部未完成/失败页面；重复执行即断点续跑
python skills/japanese-tutor/scripts/extract_curriculum.py extract

# 只重试失败页
python skills/japanese-tutor/scripts/extract_curriculum.py extract --only-failed

# 强制重跑指定页
python skills/japanese-tutor/scripts/extract_curriculum.py extract --book beginner-up --force-page 39

# 全部页面完成后，合并为技能课程数据
python skills/japanese-tutor/scripts/merge_curriculum.py
```

可用 `--max-pages 10` 做短跑，`--keep-images` 保留渲染图，`--poppler-bin <目录>` 指定 Poppler。默认单并发调用 `qwen3.8:27b`；停止进程后再次执行相同命令即可继续。
