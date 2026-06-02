"""历史记忆索引的单元测试。"""

from __future__ import annotations

import re
import time
from datetime import date, timedelta
from pathlib import Path

import pytest

from nanobot.agent.historical_memory import (
    HistoricalMemoryIndex,
    RecentNote,
    SearchHit,
    _clean_body,
    _extract_date,
    _parse_frontmatter,
    _segment_query,
    _segment_text,
    get_index,
    register_index,
)
from nanobot.config.schema import HistoricalMemoryConfig


# ---------------------------------------------------------------------------
# 工具函数测试
# ---------------------------------------------------------------------------


def test_segment_text_cjk():
    """CJK 字符拆成单字，ASCII 词保留整体。"""
    result = _segment_text("今天鸣潮上线了nanobot测试")
    tokens = result.split()
    assert "鸣" in tokens
    assert "潮" in tokens
    assert "nanobot" in tokens


def test_segment_query_two_char():
    """两字中文词转为 phrase 表达式。"""
    assert _segment_query("鸣潮") == '"鸣 潮"'
    assert _segment_query("迁移") == '"迁 移"'


def test_segment_query_single_char():
    """单字中文不加 phrase 引号。"""
    assert _segment_query("潮") == "潮"


def test_segment_query_multi_word():
    """多字短语转 phrase。"""
    assert _segment_query("暗色神具的魔王") == '"暗 色 神 具 的 魔 王"'


def test_segment_query_ascii():
    """纯 ASCII 查询保持原样。"""
    assert _segment_query("nanobot") == "nanobot"


def test_extract_date_from_filename():
    """从文件名提取日期。"""
    pattern = re.compile(r"(\d{4}-\d{2}-\d{2})")
    path = Path("/diary/2026/05/2026-05-30 周六.md")
    assert _extract_date(path, pattern) == "2026-05-30"


def test_extract_date_from_path():
    """文件名无日期时从路径提取。"""
    pattern = re.compile(r"(\d{4}-\d{2}-\d{2})")
    path = Path("/diary/2026-01-01/note.md")
    assert _extract_date(path, pattern) == "2026-01-01"


def test_parse_frontmatter_basic():
    """解析 frontmatter 标量字段。"""
    raw = "---\n概要: 今天是美好的一天\n心情:\n  - 开心\n  - 平静\n---\n正文内容"
    fields, body = _parse_frontmatter(raw)
    assert fields.get("概要") == "今天是美好的一天"
    assert "开心" in fields.get("心情", "")
    assert body.strip() == "正文内容"


def test_parse_frontmatter_no_frontmatter():
    """没有 frontmatter 时返回空字典和原文。"""
    raw = "普通日记内容，没有 frontmatter"
    fields, body = _parse_frontmatter(raw)
    assert fields == {}
    assert body == raw


def test_clean_body_removes_noise():
    """去除 JSON 块、embed 图片、wikilink、嵌套 callout 等噪声。"""
    body = """
## 天气
```json
{"temp": 35}
```
![[photo.jpg]]
[[2026-05-29 周五]]
>> - 地区：北京市-朝阳区
>> - 温度: 35℃
> [!quote] 名言
> 正文保留的引用
普通正文
"""
    cleaned = _clean_body(body)
    assert "35}" not in cleaned           # JSON 块已去掉
    assert "photo.jpg" not in cleaned     # embed 已去掉
    assert "地区：北京市" not in cleaned  # >> 嵌套行已去掉
    assert "温度" not in cleaned          # >> 嵌套行已去掉
    assert "正文保留的引用" in cleaned    # 单层 > 引用保留
    assert "普通正文" in cleaned


# ---------------------------------------------------------------------------
# 索引集成测试
# ---------------------------------------------------------------------------


def _date_str(days_ago: int) -> str:
    return (date.today() - timedelta(days=days_ago)).strftime("%Y-%m-%d")


@pytest.fixture
def diary_dir(tmp_path: Path) -> Path:
    """创建临时日记目录，放入几个测试 md 文件（日期基于 today 偏移）。"""
    d = tmp_path / "diary"
    d.mkdir()

    (d / f"{_date_str(2)} 周六.md").write_text(
        "---\n概要: 周六迁移 nanobot 到新环境\n心情:\n  - 成就感\n---\n"
        "下午精力基本全投在鸣潮和 nanobot 上，完成了迁移。绯雪手办到家。\n",
        encoding="utf-8",
    )
    (d / f"{_date_str(1)} 周日.md").write_text(
        "---\n概要: 休息日折腾配置\n心情:\n  - 放松\n---\n"
        "终于可以好好休息了，暗色神具的魔王打到第三章。\n",
        encoding="utf-8",
    )
    (d / f"{_date_str(45)}.md").write_text(
        "---\n概要: 普通工作日\n---\n茑町千岁今天生日，公司送了蛋糕。\n",
        encoding="utf-8",
    )
    return d


def _make_config(diary_dir: Path, tmp_path: Path) -> HistoricalMemoryConfig:
    return HistoricalMemoryConfig(
        enabled=True,
        paths=[str(diary_dir)],
        glob="**/*.md",
        index_path=str(tmp_path / "test_index.db"),
        preload_recent_days=2,
        search_top_k=5,
    )


def test_refresh_indexes_all_files(diary_dir: Path, tmp_path: Path):
    """refresh 后所有日记文件都进了索引。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    changed = idx.refresh()
    assert changed == 3
    assert idx.is_ready


def test_search_two_char_chinese(diary_dir: Path, tmp_path: Path):
    """2 字中文关键词（鸣潮/绯雪/迁移）能正确命中。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    for kw in ("鸣潮", "绯雪", "迁移"):
        hits = idx.search(kw)
        assert len(hits) > 0, f"关键词 {kw!r} 应能命中"
        assert all(isinstance(h, SearchHit) for h in hits)


def test_search_long_phrase(diary_dir: Path, tmp_path: Path):
    """多字短语（暗色神具的魔王）能命中。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("暗色神具的魔王")
    assert len(hits) > 0


def test_search_person_name(diary_dir: Path, tmp_path: Path):
    """人名（茑町千岁）能命中。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("茑町千岁")
    assert len(hits) > 0


def test_search_no_result(diary_dir: Path, tmp_path: Path):
    """不存在的关键词返回空列表。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("zzznomatch999")
    assert hits == []


def test_search_hit_fields(diary_dir: Path, tmp_path: Path):
    """命中结果包含 path/date/summary 字段。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("茑町千岁")
    hit = hits[0]
    assert hit.date == _date_str(45)
    assert "普通工作日" in hit.summary
    assert hit.path.endswith(".md")


def test_refresh_incremental(diary_dir: Path, tmp_path: Path):
    """修改单个文件后 refresh 只重建该文件。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    # 修改一个文件
    target = diary_dir / f"{_date_str(45)}.md"
    time.sleep(0.01)  # 确保 mtime 变化
    target.write_text(
        "---\n概要: 修改后的内容\n---\n茑町千岁今天生日，新内容加了绯雪关键词。\n",
        encoding="utf-8",
    )
    target.touch()

    changed = idx.refresh()
    assert changed == 1  # 只重建了 1 个文件


def test_refresh_deleted_file(diary_dir: Path, tmp_path: Path):
    """删除文件后 refresh 从索引中移除它。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    # 删除文件
    (diary_dir / f"{_date_str(45)}.md").unlink()
    changed = idx.refresh()
    assert changed == 1

    # 搜索已删除文件的内容应返回空
    hits = idx.search("茑町千岁")
    assert len(hits) == 0


def test_recent_returns_notes(diary_dir: Path, tmp_path: Path):
    """recent() 返回 RecentNote 列表，按 date 倒序。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    # 取足够多天数确保拿到数据
    notes = idx.recent(365)
    assert len(notes) == 3
    assert all(isinstance(n, RecentNote) for n in notes)
    # 验证倒序
    dates = [n.date for n in notes]
    assert dates == sorted(dates, reverse=True)


def test_recent_respects_days(diary_dir: Path, tmp_path: Path):
    """recent(days) 只返回 cutoff 之后的日记。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    notes = idx.recent(7)
    cutoff = _date_str(6)  # recent(7) 包含今天往前 6 天
    for n in notes:
        assert n.date >= cutoff, f"recent(7) 不应包含 {n.date}"


def test_registry(diary_dir: Path, tmp_path: Path):
    """register_index / get_index 模块级注册表正常工作。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    workspace = str(tmp_path)

    assert get_index(workspace) is None
    register_index(workspace, idx)
    assert get_index(workspace) is idx


def test_not_ready_before_refresh(diary_dir: Path, tmp_path: Path):
    """未调用 refresh 前 is_ready=False，search 返回空列表。"""
    cfg = _make_config(diary_dir, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    assert not idx.is_ready
    assert idx.search("鸣潮") == []
    assert idx.recent(7) == []


# ---------------------------------------------------------------------------
# 只读白名单测试（filesystem 工具层）
# ---------------------------------------------------------------------------


def test_readonly_tool_flag():
    """WriteFileTool / EditFileTool 的 _allow_historical_dirs 为 False。"""
    from nanobot.agent.tools.filesystem import EditFileTool, ReadFileTool, WriteFileTool

    assert ReadFileTool._allow_historical_dirs is True
    assert WriteFileTool._allow_historical_dirs is False
    assert EditFileTool._allow_historical_dirs is False


def test_search_tool_inherits_flag():
    """GrepTool / FindFilesTool 继承 _allow_historical_dirs=True。"""
    from nanobot.agent.tools.search import FindFilesTool, GrepTool

    assert GrepTool._allow_historical_dirs is True
    assert FindFilesTool._allow_historical_dirs is True
