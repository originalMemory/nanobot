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
    _extract_date_from_frontmatter,
    _extract_frontmatter_text,
    _make_snippet,
    _parse_frontmatter,
    get_index,
    register_index,
)
from nanobot.config.schema import HistoricalMemoryConfig


# ---------------------------------------------------------------------------
# 工具函数测试
# ---------------------------------------------------------------------------


def test_make_snippet_truncates_with_ellipsis():
    """长文本截断时在首尾加省略号。"""
    content = "a" * 200 + "鸣潮" + "b" * 200
    snippet = _make_snippet(content, ["鸣潮"], context_chars=20)
    assert snippet.startswith("…")
    assert snippet.endswith("…")
    assert "鸣潮" in snippet


def test_make_snippet_short_content_no_ellipsis():
    """短文本无需截断时不加省略号。"""
    content = "今天鸣潮上线了"
    snippet = _make_snippet(content, ["鸣潮"])
    assert snippet == content
    assert "…" not in snippet


def test_search_hit_format_no_double_ellipsis():
    """format() 不再额外包裹省略号，避免与 snippet 重复。"""
    hit = SearchHit(
        path="/x.md",
        date="2024-01-01",
        summary="概要",
        snippet="…关键词上下文…",
        match_type="and",
    )
    formatted = hit.format()
    assert "……" not in formatted
    assert formatted.count("…") == 2


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


def test_extract_date_from_frontmatter_created():
    """从 frontmatter created 字段提取日期。"""
    fields = {"created": "2023-10-19T10:00"}
    path = Path("/some/note.md")
    assert _extract_date_from_frontmatter(fields, path) == "2023-10-19"


def test_extract_date_from_frontmatter_date_key():
    """从 frontmatter date 字段提取日期。"""
    fields = {"date": "2024-03-15"}
    path = Path("/some/note.md")
    assert _extract_date_from_frontmatter(fields, path) == "2024-03-15"


def test_extract_frontmatter_text_filters_wikilinks():
    """_extract_frontmatter_text 过滤 wikilink 图片，保留普通字段值。"""
    fields = {
        "figureSource": "紫罗兰永恒花园",
        "figureCreator": "繁缕",
        "cover": "[[72fdafd3218271acf8db48cb41b7affc.jpg]]",
    }
    text = _extract_frontmatter_text(fields)
    assert "紫罗兰永恒花园" in text
    assert "繁缕" in text
    assert "72fdafd" not in text


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
def note_root(tmp_path: Path) -> Path:
    """创建临时笔记根目录，包含日记子目录和其他笔记文件。"""
    root = tmp_path / "note"
    root.mkdir()

    # 日记目录
    diary = root / "日记"
    diary.mkdir()
    (diary / f"{_date_str(2)} 周六.md").write_text(
        "---\n概要: 周六迁移 nanobot 到新环境\n心情:\n  - 成就感\n---\n"
        "下午精力基本全投在鸣潮和 nanobot 上，完成了迁移。绯雪手办到家。\n",
        encoding="utf-8",
    )
    (diary / f"{_date_str(1)} 周日.md").write_text(
        "---\n概要: 休息日折腾配置\n心情:\n  - 放松\n---\n"
        "终于可以好好休息了，暗色神具的魔王打到第三章。\n",
        encoding="utf-8",
    )
    (diary / f"{_date_str(45)}.md").write_text(
        "---\n概要: 普通工作日\n---\n茑町千岁今天生日，公司送了蛋糕。\n",
        encoding="utf-8",
    )

    # 手办购买记录（note 类型，frontmatter 含有价值字段）
    figure_dir = root / "手办" / "购买记录"
    figure_dir.mkdir(parents=True)
    (figure_dir / "繁缕-薇尔莉特.md").write_text(
        f"---\nfigureSource: 紫罗兰永恒花园\nfigureCreator: 繁缕\n"
        f"figureOrderDate: 2023-10-19\ncreated: 2023-10-19T10:00\n---\n",
        encoding="utf-8",
    )

    return root


def _make_config(note_root: Path, tmp_path: Path) -> HistoricalMemoryConfig:
    return HistoricalMemoryConfig(
        enabled=True,
        root=str(note_root),
        diary_path="日记",
        glob="**/*.md",
        preload_recent_days=2,
        search_top_k=5,
    )


# backward-compat alias for tests that still reference diary_dir
@pytest.fixture
def diary_dir(note_root: Path) -> Path:
    return note_root / "日记"


def test_refresh_indexes_all_files(note_root: Path, tmp_path: Path):
    """refresh 后所有文件（日记+笔记）都进了索引。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    changed = idx.refresh()
    assert changed == 4  # 3 日记 + 1 手办记录
    assert idx.is_ready


def test_search_two_char_chinese(note_root: Path, tmp_path: Path):
    """2 字中文关键词（鸣潮/绯雪/迁移）能正确命中日记。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    for kw in ("鸣潮", "绯雪", "迁移"):
        hits = idx.search(kw)
        assert len(hits) > 0, f"关键词 {kw!r} 应能命中"
        assert all(isinstance(h, SearchHit) for h in hits)


def test_search_long_phrase(note_root: Path, tmp_path: Path):
    """多字短语（暗色神具的魔王）能命中。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("暗色神具的魔王")
    assert len(hits) > 0


def test_search_person_name(note_root: Path, tmp_path: Path):
    """人名（茑町千岁）能命中。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("茑町千岁")
    assert len(hits) > 0


def test_search_no_result(note_root: Path, tmp_path: Path):
    """不存在的关键词返回空列表。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("zzznomatch999")
    assert hits == []


def test_search_hit_fields(note_root: Path, tmp_path: Path):
    """命中结果包含 path/date/summary 字段。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    hits = idx.search("茑町千岁")
    hit = hits[0]
    assert hit.date == _date_str(45)
    assert "普通工作日" in hit.summary
    assert hit.path.endswith(".md")


def test_search_since_until_date_filter(note_root: Path, tmp_path: Path):
    """since/until 按日记 date 过滤，可只传其一。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    assert len(idx.search("鸣潮", since=_date_str(3))) == 1
    assert idx.search("鸣潮", since=_date_str(1)) == []

    assert len(idx.search("茑町千岁", until=_date_str(30))) == 1
    assert idx.search("茑町千岁", since=_date_str(10)) == []

    recent_hits = idx.search("鸣潮", since=_date_str(3), until=_date_str(2))
    assert len(recent_hits) == 1
    assert recent_hits[0].date == _date_str(2)


def test_refresh_incremental(note_root: Path, tmp_path: Path, diary_dir: Path):
    """修改单个文件后 refresh 只重建该文件。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    target = diary_dir / f"{_date_str(45)}.md"
    time.sleep(0.01)  # 确保 mtime 变化
    target.write_text(
        "---\n概要: 修改后的内容\n---\n茑町千岁今天生日，新内容加了绯雪关键词。\n",
        encoding="utf-8",
    )
    target.touch()

    changed = idx.refresh()
    assert changed == 1


def test_refresh_deleted_file(note_root: Path, tmp_path: Path, diary_dir: Path):
    """删除文件后 refresh 从索引中移除它。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    (diary_dir / f"{_date_str(45)}.md").unlink()
    changed = idx.refresh()
    assert changed == 1

    hits = idx.search("茑町千岁")
    assert len(hits) == 0


def test_recent_returns_only_diary(note_root: Path, tmp_path: Path):
    """recent() 只返回 diary 类型，不含 note 类型笔记。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    notes = idx.recent(365)
    assert len(notes) == 3  # 只有 3 条日记，手办记录不在其中
    assert all(isinstance(n, RecentNote) for n in notes)
    dates = [n.date for n in notes]
    assert dates == sorted(dates, reverse=True)


def test_recent_respects_days(note_root: Path, tmp_path: Path):
    """recent(days) 只返回 cutoff 之后的日记。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    notes = idx.recent(7)
    cutoff = _date_str(6)
    for n in notes:
        assert n.date >= cutoff, f"recent(7) 不应包含 {n.date}"


def test_note_frontmatter_indexed(note_root: Path, tmp_path: Path):
    """note 类型：frontmatter 字段值（figureSource/figureCreator）可被搜索命中。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    for kw in ("紫罗兰永恒花园", "繁缕"):
        hits = idx.search(kw)
        assert len(hits) > 0, f"note frontmatter 关键词 {kw!r} 应能命中"


def test_note_date_from_frontmatter(note_root: Path, tmp_path: Path):
    """note 类型：日期从 frontmatter created 字段提取。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()

    hits = idx.search("紫罗兰永恒花园")
    assert len(hits) > 0
    assert hits[0].date == "2023-10-19"


def test_note_not_in_recent(note_root: Path, tmp_path: Path):
    """note 类型不出现在 recent() 结果中，即使日期在范围内。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    idx.refresh()
    notes = idx.recent(365)
    paths = [n.path for n in notes]
    assert not any("手办" in p for p in paths)


def test_registry(note_root: Path, tmp_path: Path):
    """register_index / get_index 模块级注册表正常工作。"""
    cfg = _make_config(note_root, tmp_path)
    idx = HistoricalMemoryIndex(cfg, tmp_path)
    workspace = str(tmp_path)

    assert get_index(workspace) is None
    register_index(workspace, idx)
    assert get_index(workspace) is idx


def test_not_ready_before_refresh(note_root: Path, tmp_path: Path):
    """未调用 refresh 前 is_ready=False，search 返回空列表。"""
    cfg = _make_config(note_root, tmp_path)
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
