"""语音文本清洗与中日分段测试。"""

from nanobot.agent.voice_text import clean_for_tts, contains_kana, validate_language_tags


def test_clean_removes_markdown():
    text = "## 标题\n- 列表项\n**加粗** 和 `代码`\n"
    out = clean_for_tts(text)
    assert "标题" in out and "列表项" in out and "加粗" in out and "代码" not in out
    assert "#" not in out and "*" not in out and "`" not in out


def test_clean_keeps_informative_parentheses():
    text = "大小（913 MB），日期（10-17）"
    out = clean_for_tts(text)
    assert "（913 MB）" in out and "（10-17）" in out


def test_clean_drops_action_parentheses():
    text = "（摇尾巴）好的喵（叹气）"
    out = clean_for_tts(text)
    assert "摇尾巴" not in out and "叹气" not in out and "好的喵" in out


def test_clean_compresses_paths():
    text = "已移到 /nas/hdd/待整理/百度/1233 目录"
    out = clean_for_tts(text)
    assert "/nas/hdd" not in out and "路径省略" in out


def test_clean_removes_code_blocks_and_urls():
    text = "结果：```json {\"a\": 1} ``` 详见 https://example.com/x"
    out = clean_for_tts(text)
    assert "json" not in out and "http" not in out


def test_clean_flattens_table_rows():
    text = "| 项目 | 数值 |\n| --- | --- |\n| 睡眠 | 8h |"
    out = clean_for_tts(text)
    assert "睡眠、8h" in out
    assert "---" not in out


def test_contains_kana():
    assert contains_kana("すずめ真好听")
    assert contains_kana("カタカナ")
    assert not contains_kana("完全中文内容")


def test_validate_language_tags_no_tags_ok():
    assert validate_language_tags("纯中文文本")


def test_validate_language_tags_full_coverage_ok():
    assert validate_language_tags("[zh]中文[/zh][ja]日本語[/ja]")


def test_validate_language_tags_uncovered_rejected():
    assert not validate_language_tags("未标注文本[zh]已标注[/zh]")
    assert not validate_language_tags("[zh]已标注[/zh]尾部未标注")
