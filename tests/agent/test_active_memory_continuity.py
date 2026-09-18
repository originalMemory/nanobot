"""连续记忆回归：以脱敏场景覆盖提词、正式证据和主题生命周期。"""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from nanobot.agent import active_memory as memory
from nanobot.agent.diary_search import (
    canonical_diary_files,
    diary_body,
    search_diary_files,
)
from nanobot.agent.hook import AgentHookContext, AgentRunHookContext


def note(root, date="2026-01-01", body="星海的角色月白登场。", summary="星海更新"):
    path = root / f"{date} 周一.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n概要: {summary}\n心情: 平淡\n---\n\n{body}\n", encoding="utf-8")
    return str(path)


def card(root, topic="星海", **extra):
    data = {"schema_version": memory.TOPIC_CARD_SCHEMA_VERSION, "topic": topic, "aliases": [], "summary": "旧摘要",
            "related_entities": [], **extra}
    memory._write_json(memory._topic_path(root, topic), data)
    return data


def entity(name="月白"):
    return {"name": name, "relation": "专属角色", "exclusive": True,
            "sources": ["2026-01-01 周一.md"],
            "evidence": [{"path": "2026-01-01 周一.md", "quote": f"星海的角色{name}登场。"}]}


def test_long_topic_card_preserves_full_summary_fresh_evidence_and_stale_warning():
    summary = "旧经历。" * 3000
    hits = [{"date": "2026-09-18", "path": "2026-09-18.md", "snippet": "用户今天明确停止这个项目", "matched": ["项目"]}]
    result = memory._format_injection(hits, {"topic": "项目", "summary": summary, "_stale": True})
    assert summary in result
    assert "主题摘要尚未同步最新证据" in result
    assert "用户今天明确停止这个项目" in result
    assert "[来源：2026-09-18.md]" in result
    assert result.endswith("[/Active Memory]")


@pytest.mark.parametrize(("raw", "text", "expected"), [
    ("第 3 张", "收藏第3张，再来几张", ""),
    ("fa 酒店 酒店", "fa的雕像补款了", "fa"),
    ("image.jpg", "收到image.jpg", ""),
    ("/home/data", "看一下/home/data", ""),
    ("星海 星海", "继续聊星海", "星海"),
    ("MOD mod", "我装了MOD", "MOD"),
    ("月白", "无相关角色信息", ""),
    ("115", "115挂载好了", "115"),
])
def test_query_contract(tmp_path, raw, text, expected):
    card(tmp_path, "115网盘", aliases=["115"])
    result, _ = memory._validate_keywords(raw, text, tmp_path)
    assert result == expected


def test_input_removes_wrappers_preserves_actual_text():
    raw = "[Image]\nReceived files:\n- image.jpg\n  saved: /home/image.jpg\n\n这盆月季开花了\n[Runtime Context]\n旧关键词"
    assert memory._extract_text(raw) == "这盆月季开花了"
    assert memory._extract_text("继续聊天\n[Active Memory — reference only]\n旧证据") == "继续聊天"


def test_duplicate_files_cannot_fill_recall_or_qualify_topic(tmp_path):
    original = note(tmp_path)
    for i in range(25):
        (tmp_path / f"2026-01-01 周一.sync-conflict-{i}.md").write_text(Path(original).read_text(encoding="utf-8"), encoding="utf-8")
    result = memory._search_diary("星海", str(tmp_path))
    assert len(result.hits) == 1
    assert result.topic is None
    assert len(canonical_diary_files({str(p) for p in tmp_path.glob('*.md')})) == 1


def test_body_ignores_weather_and_empty_summary(tmp_path):
    filename = note(tmp_path, body="买了新相机。\n\n# 天气\n星海天气数据", summary="")
    assert memory._extract_summary(Path(filename).read_text(encoding="utf-8")) == ""
    assert memory._search_diary("星海", str(tmp_path)).hits == []
    assert "天气数据" not in diary_body(Path(filename).read_text(encoding="utf-8"))


def test_excerpt_keeps_actual_event_not_unrelated_summary(tmp_path):
    note(tmp_path, body="邻居上月借书，今天按约定归还。", summary="今天讨论了电脑和游戏。")
    result = memory._search_diary("邻居", str(tmp_path))
    assert "按约定归还" in result.hits[0]["snippet"]
    assert "电脑" not in result.hits[0]["snippet"]


def test_literal_query_is_not_option_or_regex(tmp_path):
    filename = note(tmp_path, body="讨论 --help 和 a.b 文件。")
    note(tmp_path, date="2026-02-01", body="仅有 axb。")
    assert search_diary_files(tmp_path, "--help") == {filename}
    assert search_diary_files(tmp_path, "a.b") == {filename}


def test_independent_topic_not_captured_by_cooccurrence(tmp_path):
    topics = tmp_path / "topics"
    card(topics, "菜品甲")
    for i in range(20):
        note(tmp_path, date=f"{2024 + i // 12}-{i % 12 + 1:02d}-01",
             body="玩了星海。\n\n吃了菜品甲。")
    result = memory._search_diary("星海", str(tmp_path), topics)
    assert result.topic == "星海"
    assert result.topic_card is None


def test_legacy_entities_do_not_inherit_but_summary_survives(tmp_path):
    card(tmp_path, "菜品甲", schema_version=5, related_entities=[entity("助手甲")])
    assert memory._find_topic_card(tmp_path, ["助手甲"]) is None
    assert memory._find_topic_card(tmp_path, ["菜品甲"])["summary"] == "旧摘要"


def test_confirmed_entity_and_multiword_alias(tmp_path):
    card(tmp_path, aliases=["Star Ocean"], related_entities=[entity()])
    assert memory._find_topic_card(tmp_path, ["月白"])["_match_kind"] == "related"
    assert memory._find_topic_card(tmp_path, ["star", "ocean"])["_match_kind"] == "alias"
    assert memory._find_topic_card(tmp_path, ["Star Ocean"])["_match_kind"] == "alias"


def test_ambiguous_parent_does_not_pick_largest_card(tmp_path):
    card(tmp_path, related_entities=[entity()], source_count=100)
    card(tmp_path, "另一作品", related_entities=[entity()], source_count=1)
    assert memory._find_topic_card(tmp_path, ["月白"]) is None


def test_related_topic_does_not_inherit(tmp_path):
    card(tmp_path, related_topics=[{"name": "MOD", "relation": "扩展内容"}])
    assert memory._find_topic_card(tmp_path, ["MOD"]) is None


def test_fingerprint_ignores_weather_and_absolute_root(tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    a, b = note(first), note(second)
    fp = memory._topic_fingerprint([a], ("星海",), str(first))
    Path(b).write_text(Path(b).read_text(encoding="utf-8") + "\n# 天气\n温度: 30\n", encoding="utf-8")
    assert fp == memory._topic_fingerprint([b], ("星海",), str(second))
    Path(b).write_text(Path(b).read_text(encoding="utf-8").replace("登场", "离开"), encoding="utf-8")
    assert fp != memory._topic_fingerprint([b], ("星海",), str(second))


def test_unreadable_sources_keep_old_card(tmp_path, monkeypatch):
    topics = tmp_path / "topics"
    card(topics)
    def fail(*args):
        raise OSError("incomplete")
    monkeypatch.setattr(memory, "_grep_files", fail)
    result = memory._search_diary("星海", str(tmp_path), topics)
    assert not result.source_complete
    assert result.topic_card["summary"] == "旧摘要"
    assert result.topic_card["_stale"]


async def test_build_card_validates_quote_and_preserves_unknown_fields(tmp_path):
    filename = note(tmp_path, body="星海的角色月白登场。\n\n去商店购物。")
    topics = tmp_path / "topics"
    card(topics, custom_audit="keep", source_count=100, date_range=["1999-01-01"],
         rejected_relations=[], related_topics=[{"name": "旧主题", "relation": "旧关系"}],
         migration_note="一次性说明")
    fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    bad = entity("商店")
    bad["evidence"][0]["quote"] = "星海的角色商店登场。"
    response = {"topic": "星海", "summary": "截至1月仍在游玩", "related_entities": [entity(), bad],
                "related_topics": [{"name": "MOD", "relation": "未见证据"}]}
    model = AsyncMock(return_value=json.dumps(response, ensure_ascii=False))
    assert await memory._build_topic_card(topic="星海", files=[filename], fingerprint=fp,
                                         topic_dir=topics, summarize=model, diary_root=str(tmp_path))
    saved = json.loads(memory._topic_path(topics, "星海").read_text(encoding="utf-8"))
    assert len(saved["source_files"]) == 1  # 完整证据减少可以修正旧卡。
    assert not {"source_count", "date_range", "rejected_relations", "migration_note"} & saved.keys()
    assert saved["custom_audit"] == "keep"
    assert [e["name"] for e in saved["related_entities"]] == ["月白"]
    assert saved["related_entities"][0] == {
        "name": "月白", "relation": "专属角色", "sources": ["2026-01-01 周一.md"],
    }
    assert "related_topics" not in saved
    assert "related_topics" not in model.call_args.args[0]
    assert saved["schema_version"] == 7
    assert "助手、用户、供应商" in model.call_args.args[0]


async def test_source_change_during_generation_does_not_replace(tmp_path):
    filename = note(tmp_path)
    topics = tmp_path / "topics"
    card(topics)
    fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    async def model(prompt):
        note(tmp_path, date="2026-02-01")
        return '{"topic":"星海","summary":"过期结果"}'
    assert not await memory._build_topic_card(topic="星海", files=[filename], fingerprint=fp,
                                              topic_dir=topics, summarize=model, diary_root=str(tmp_path))
    assert json.loads(memory._topic_path(topics, "星海").read_text(encoding="utf-8"))["summary"] == "旧摘要"


async def test_generation_failure_single_flight_and_persistent_cooldown(tmp_path):
    filename = note(tmp_path)
    fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    scheduled = []
    model = AsyncMock(side_effect=RuntimeError("offline"))
    hook = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    hook.configure_topic_summary(model, scheduled.append)
    hook._maybe_schedule_topic_card("星海", [filename], fp, request_id="test")
    hook._maybe_schedule_topic_card("星海", [filename], fp)
    assert not scheduled
    await hook.on_finally(AgentRunHookContext(messages=[]))
    assert len(scheduled) == 1
    await scheduled.pop()
    fresh = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    fresh.configure_topic_summary(model, scheduled.append)
    fresh._maybe_schedule_topic_card("星海", [filename], fp)
    await fresh.on_finally(AgentRunHookContext(messages=[]))
    assert not scheduled
    assert model.await_count == 1
    assert memory._load_topic_decision(hook._topic_dir, "星海", fp) is None
    logs = [json.loads(line) for line in hook._log_path.read_text(encoding="utf-8").splitlines()]
    assert any(x.get("reason") == "retry_cooldown" for x in logs)
    assert all(x.get("timestamp") and x.get("rule_version") for x in logs)


async def test_rejection_rechecks_only_changed_evidence(tmp_path):
    filename = note(tmp_path)
    fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    scheduled = []
    model = AsyncMock(return_value='{"action":"no_save","reason":"证据不足"}')
    hook = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    hook.configure_topic_summary(model, scheduled.append)
    hook._maybe_schedule_topic_card("星海", [filename], fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    hook._maybe_schedule_topic_card("星海", [filename], fp)
    assert not hook._pending_topic_cards
    Path(filename).write_text(Path(filename).read_text(encoding="utf-8") + "\n星海后续新增阶段。", encoding="utf-8")
    new_fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    hook._maybe_schedule_topic_card("星海", [filename], new_fp)
    assert hook._pending_topic_cards
    assert memory._load_topic_decision(hook._topic_dir, "星海", new_fp) is None


async def test_successful_upgrade_does_not_rebuild_unchanged_evidence(tmp_path):
    filename = note(tmp_path)
    fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    topics = tmp_path / "memory/active_memory_topics"
    card(topics, schema_version=5)
    model = AsyncMock(return_value='{"topic":"星海","summary":"新摘要"}')
    scheduled = []
    hook = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    hook.configure_topic_summary(model, scheduled.append)
    hook._maybe_schedule_topic_card("星海", [filename], fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    hook._maybe_schedule_topic_card("星海", [filename], fp)
    assert not hook._pending_topic_cards
    assert model.await_count == 1


async def test_invalid_model_output_keeps_previous_card(tmp_path):
    filename = note(tmp_path)
    fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    topics = tmp_path / "topics"
    old = card(topics)
    for output in ['not json', '{"summary":[]}', '{}']:
        assert not await memory._build_topic_card(topic="星海", files=[filename], fingerprint=fp,
                                                  topic_dir=topics, summarize=AsyncMock(return_value=output),
                                                  diary_root=str(tmp_path))
    assert json.loads(memory._topic_path(topics, "星海").read_text(encoding="utf-8")) == old


async def test_card_generation_keeps_large_evidence_in_one_call(tmp_path):
    from datetime import date, timedelta
    files = [note(tmp_path, str(date(2025, 1, 1) + timedelta(days=i)), body=f"星海记录编号{i}。")
             for i in range(81)]
    fp = memory._topic_fingerprint(files, ("星海",), str(tmp_path))
    model = AsyncMock(return_value='{"topic":"星海","summary":"长期脉络"}')
    assert await memory._build_topic_card(topic="星海", files=files, fingerprint=fp,
                                         topic_dir=tmp_path / "topics", summarize=model, diary_root=str(tmp_path))
    assert model.await_count == 1
    assert "编号0" in model.call_args.args[0] and "编号80" in model.call_args.args[0]


async def test_invalid_query_leaves_current_conversation_intact(tmp_path, monkeypatch):
    hook = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    monkeypatch.setattr(hook, "_extract_keywords", AsyncMock(return_value="第 3 张"))
    messages = [{"role": "user", "content": "刚才那张图片很好看"},
                {"role": "user", "content": "收藏第3张，再来几张"}]
    before = [dict(m) for m in messages]
    await hook.before_iteration(AgentHookContext(iteration=0, messages=messages))
    assert messages == before
    assert not hook._pending_topic_cards




async def test_canonical_rename_cannot_overwrite_another_card(tmp_path):
    filename = note(tmp_path, body="Star Ocean 即星海，月白是其中角色。")
    topics = tmp_path / "topics"
    card(topics, custom="keep")
    fp = memory._topic_fingerprint([filename], ("Star Ocean",), str(tmp_path))
    model = AsyncMock(return_value='{"topic":"星海","aliases":["Star Ocean"],"summary":"窄摘要"}')
    assert not await memory._build_topic_card(topic="Star Ocean", files=[filename], fingerprint=fp,
                                              topic_dir=topics, summarize=model, diary_root=str(tmp_path))
    assert json.loads(memory._topic_path(topics, "星海").read_text(encoding="utf-8"))["custom"] == "keep"


async def test_canonical_rename_preserves_alias_without_old_hash(tmp_path):
    filename = note(tmp_path, body="Star Ocean 即星海，月白是其中角色。")
    topics = tmp_path / "topics"
    card(topics, "Star Ocean")
    fp = memory._topic_fingerprint([filename], ("Star Ocean",), str(tmp_path))
    model = AsyncMock(return_value='{"topic":"星海","aliases":["Star Ocean"],"summary":"新摘要"}')
    assert await memory._build_topic_card(topic="Star Ocean", files=[filename], fingerprint=fp,
                                         topic_dir=topics, summarize=model, diary_root=str(tmp_path))
    assert not memory._topic_path(topics, "Star Ocean").exists()
    assert memory._find_topic_card(topics, ["Star", "Ocean"])["topic"] == "星海"


async def test_missing_source_never_replaces_previous_card(tmp_path):
    filename = note(tmp_path)
    topics = tmp_path / "topics"
    original = card(topics)
    fp = memory._topic_fingerprint([filename], ("星海",), str(tmp_path))
    Path(filename).unlink()
    model = AsyncMock()
    with pytest.raises(OSError):
        await memory._build_topic_card(topic="星海", files=[filename], fingerprint=fp,
                                       topic_dir=topics, summarize=model, diary_root=str(tmp_path))
    model.assert_not_awaited()
    assert json.loads(memory._topic_path(topics, "星海").read_text(encoding="utf-8")) == original


def test_atomic_card_write_failure_keeps_previous_file(tmp_path, monkeypatch):
    path = tmp_path / 'card.json'
    original = '{"summary":"旧摘要"}'
    path.write_text(original, encoding="utf-8")
    def fail_replace(self, target):
        raise OSError('interrupted before replace')
    monkeypatch.setattr(Path, 'replace', fail_replace)
    with pytest.raises(OSError):
        memory._write_json(path, {'summary':'新摘要'})
    assert path.read_text(encoding="utf-8") == original


def test_conflict_removal_is_visible_in_recall_log_data(tmp_path):
    filename = note(tmp_path)
    (tmp_path / '2026-01-01 周一.sync-conflict-copy.md').write_text(Path(filename).read_text(encoding="utf-8"), encoding="utf-8")
    result = memory._search_diary('星海', str(tmp_path))
    assert result.excluded_file_count == 1
    assert len(result.hits) == 1


@pytest.mark.parametrize(('raw', 'text', 'expected'), [
    ('无', '再看下115挂载目录可读吗', '115'),
    ('115', '今天训练心率115', ''),
    ('115', '115元买菜', ''),
    ('买菜', '今天一共花了115元买菜', ''),
    ('美照', '来几张美照安慰下我吧', ''),
    ('屋顶电影 美照', '上次的屋顶电影美照还记得吗', '屋顶电影'),
])
def test_live_model_failure_cases(tmp_path, raw, text, expected):
    card(tmp_path, '115网盘', aliases=['115'])
    assert memory._validate_keywords(raw, text, tmp_path)[0] == expected


def test_numeric_alias_does_not_collect_measurements_from_diaries(tmp_path):
    note(tmp_path, body='今天心率115，很轻松。', summary='训练记录')
    expected = note(tmp_path, date='2026-02-01', body='115网盘挂载恢复了。')
    result = memory._search_diary('115', str(tmp_path))
    assert [hit['path'] for hit in result.hits] == [Path(expected).name]


def test_invalid_utf8_is_incomplete_source_not_a_turn_failure(tmp_path, monkeypatch):
    filename = tmp_path / '2026-01-01.md'
    filename.write_bytes(b'\xff')
    topics = tmp_path / 'topics'
    card(topics)
    monkeypatch.setattr(memory, '_grep_files', lambda *_args: {str(filename)})
    result = memory._search_diary('星海', str(tmp_path), topics)
    assert not result.source_complete
    assert result.topic_card['summary'] == '旧摘要'


@pytest.mark.parametrize('sources, expected', [
    (['2026-03-01', '2025-01-01', '2026-03-01'], '2025-01-01～2026-03-01'),
    (['2026-02-01'], '2026-02-01～2026-02-01'),
    ([], ''),
    (['bad', '2026-02-30', None, '2026-01-01'], '2026-01-01～2026-01-01'),
])
def test_card_range_derived_from_sources(sources, expected):
    payload = memory._format_injection([], {
        'topic': '星海', 'summary': '时间线', 'sources': sources,
        'date_range': ['1999-01-01', '2099-01-01'],
    })
    assert '1999' not in payload and '2099' not in payload
    if expected:
        assert expected in payload
    else:
        assert '～' not in payload


def test_compact_entity_sources_preserve_recall_and_display(tmp_path):
    card(tmp_path, related_entities=[{
        'name': '月白', 'relation': '专属角色',
        'sources': ['2026/01/2026-01-01 周一.md'],
    }])
    matched = memory._find_topic_card(tmp_path, ['月白'])
    assert matched['_match_kind'] == 'related'
    payload = memory._format_injection([], matched)
    assert '月白：星海的专属角色；来源：2026-01-01' in payload


def test_five_dates_are_review_threshold_without_span_requirement(tmp_path):
    files = {note(tmp_path, f'2026-01-{i:02d}') for i in range(1, 6)}
    assert memory._is_long_term_topic(files)
    assert not memory._is_long_term_topic(set(sorted(files)[:4]))
    for i in range(10):
        f = tmp_path / f'2026-01-01 周一.sync-conflict-{i}.md'
        f.write_text('星海', encoding="utf-8")
        files.add(str(f))
    assert not memory._is_long_term_topic(files - {str(tmp_path / '2026-01-05 周一.md')})


async def test_no_save_cache_invalidates_when_index_changes(tmp_path):
    filename = note(tmp_path)
    fp = memory._topic_fingerprint([filename], ('星海',), str(tmp_path))
    hook = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    scheduled = []
    model = AsyncMock(return_value='{"action":"no_save","reason":"证据不足"}')
    hook.configure_topic_summary(model, scheduled.append)
    hook._maybe_schedule_topic_card('星海', [filename], fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    saved = memory._load_topic_decision(hook._topic_dir, '星海', fp)
    assert saved['action'] == 'no_save'
    assert saved['reason'] == '证据不足'
    hook._maybe_schedule_topic_card('星海', [filename], fp)
    assert not hook._pending_topic_cards
    card(hook._topic_dir, '新主题')
    assert memory._load_topic_decision(hook._topic_dir, '星海', fp) is None
    hook._maybe_schedule_topic_card('星海', [filename], fp)
    assert hook._pending_topic_cards


@pytest.mark.parametrize('action, candidate, body', [
    ('entity', '月白', '月白是星海的专属角色。'),
    ('alias', 'Star Ocean', 'Star Ocean就是星海的英文别名。'),
])
async def test_review_attaches_verified_name_without_new_card(tmp_path, action, candidate, body):
    filename = note(tmp_path, body=body)
    hook = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    parent = card(hook._topic_dir, sources=['2025-01-01'], fingerprint='parent-fp')
    fp = memory._topic_fingerprint([filename], (candidate,), str(tmp_path))
    response = {'action':action, 'reason':'证据确认归属', 'target':'星海',
                'relation':'专属角色', 'evidence':[{'path':Path(filename).name, 'quote':body}]}
    model = AsyncMock(return_value=json.dumps(response, ensure_ascii=False))
    scheduled = []
    hook.configure_topic_summary(model, scheduled.append)
    hook._maybe_schedule_topic_card(candidate, [filename], fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    assert model.await_count == 1
    prompt = model.call_args.args[0]
    assert '已有卡片索引' in prompt and '旧摘要' in prompt
    assert memory._find_topic_card(hook._topic_dir, candidate.split())['topic'] == '星海'
    assert not memory._topic_path(hook._topic_dir, candidate).exists()
    updated = json.loads(memory._topic_path(hook._topic_dir, '星海').read_text(encoding="utf-8"))
    assert updated['summary'] == parent['summary']
    assert updated['sources'] == parent['sources']
    assert updated['fingerprint'] == parent['fingerprint']
    if action == 'entity':
        assert updated['related_entities'] == [{'name':'月白','relation':'专属角色',
                                               'sources':[Path(filename).name]}]
    cache = json.loads(memory._topic_decision_path(hook._topic_dir, candidate).read_text(encoding="utf-8"))
    assert cache['action'] == action
    assert 'evidence' not in cache and 'sources' not in cache


async def test_new_topic_review_builds_independent_card(tmp_path):
    filename = note(tmp_path)
    hook = memory.ActiveMemoryHook(str(tmp_path), tmp_path)
    fp = memory._topic_fingerprint([filename], ('星海',), str(tmp_path))
    model = AsyncMock(side_effect=['{"action":"new","reason":"独立作品"}',
                                  '{"topic":"星海","summary":"新作品脉络"}'])
    scheduled=[]
    hook.configure_topic_summary(model,scheduled.append)
    hook._maybe_schedule_topic_card('星海',[filename],fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    assert model.await_count == 2
    assert memory._find_topic_card(hook._topic_dir, ['星海'])['summary'] == '新作品脉络'


@pytest.mark.parametrize('response', [
    {'action':'entity','target':'不存在','relation':'角色','evidence':[]},
    {'action':'alias','target':'星海','evidence':[{'path':'2026-01-01 周一.md','quote':'编造的证据'}]},
    {'action':'never_save'},
    {'eligible':False},
])
async def test_invalid_review_is_failure_not_no_save(tmp_path, response):
    filename=note(tmp_path)
    model=AsyncMock(return_value=json.dumps({'reason':'测试',**response},ensure_ascii=False))
    with pytest.raises(ValueError):
        await memory._assess_topic_candidate(topic='月白',files=[filename],summarize=model,
                                            index=[{'topic':'星海','aliases':[],'entities':[], 'summary':'摘要'}],
                                            diary_root=str(tmp_path))
    assert not (tmp_path/'decisions').exists()


def test_index_fingerprint_tracks_only_supplied_index_fields(tmp_path):
    original=card(tmp_path, summary='摘要', updated_at='yesterday', fingerprint='a')
    before=memory._topic_index_fingerprint(memory._topic_index(tmp_path))
    memory._write_json(memory._topic_path(tmp_path,'星海'),
                       {**original,'updated_at':'today','fingerprint':'b','sources':['2026-01-01']})
    assert before == memory._topic_index_fingerprint(memory._topic_index(tmp_path))
    memory._write_json(memory._topic_path(tmp_path,'星海'), {**original,'aliases':['Star Ocean']})
    assert before != memory._topic_index_fingerprint(memory._topic_index(tmp_path))


async def test_index_change_during_review_does_not_cache_or_attach(tmp_path):
    filename=note(tmp_path)
    hook=memory.ActiveMemoryHook(str(tmp_path),tmp_path)
    fp=memory._topic_fingerprint([filename],('星海',),str(tmp_path))
    async def model(prompt):
        card(hook._topic_dir,'新增主题')
        return '{"action":"no_save","reason":"旧索引下的判断"}'
    scheduled=[]
    hook.configure_topic_summary(model,scheduled.append)
    hook._maybe_schedule_topic_card('星海',[filename],fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    assert not memory._topic_decision_path(hook._topic_dir,'星海').exists()
    assert not memory._topic_path(hook._topic_dir,'星海').exists()


async def test_full_rebuild_does_not_overwrite_concurrent_mapping_update(tmp_path):
    filename=note(tmp_path)
    topics=tmp_path/'topics'
    original=card(topics)
    fp=memory._topic_fingerprint([filename],('星海',),str(tmp_path))
    async def model(prompt):
        memory._write_json(memory._topic_path(topics,'星海'), {**original,'aliases':['Star Ocean']})
        return '{"topic":"星海","summary":"过期生成结果"}'
    assert not await memory._build_topic_card(topic='星海',files=[filename],fingerprint=fp,
                                              topic_dir=topics,summarize=model,diary_root=str(tmp_path))
    assert memory._find_topic_card(topics,['Star','Ocean'])['summary']=='旧摘要'


async def test_rebuild_keeps_verified_mappings_when_model_omits_them(tmp_path):
    filename=note(tmp_path,body='Star Ocean就是星海，月白是星海的角色。')
    topics=tmp_path/'topics'
    card(topics)
    memory._attach_topic_candidate(topics,'Star Ocean',{
        'action':'alias','target':'星海','sources':[Path(filename).name],
    })
    memory._attach_topic_candidate(topics,'月白',{
        'action':'entity','target':'星海','relation':'角色','sources':[Path(filename).name],
    })
    previous=memory._find_topic_card(topics,['星海'])
    fp=memory._topic_fingerprint([filename],tuple(sorted(memory._topic_names(previous))),str(tmp_path))
    model=AsyncMock(return_value='{"topic":"星海","aliases":[],"related_entities":[],"summary":"更新的历史"}')
    assert await memory._build_topic_card(topic='星海',files=[filename],fingerprint=fp,
                                         topic_dir=topics,summarize=model,diary_root=str(tmp_path))
    assert '已有确认映射' in model.call_args.args[0]
    assert memory._find_topic_card(topics,['Star Ocean'])['summary']=='更新的历史'
    assert memory._find_topic_card(topics,['月白'])['topic']=='星海'


@pytest.mark.parametrize('valid_evidence',[True,False])
async def test_mapping_removal_requires_explicit_supported_correction(tmp_path,valid_evidence):
    correction='更正：Moon并不是星海别名，月白也不是星海的角色。'
    filename=note(tmp_path,body=correction)
    topics=tmp_path/'topics'
    card(topics,aliases=['Moon'],related_entities=[{
        'name':'月白','relation':'角色','sources':[Path(filename).name],
    }])
    fp=memory._topic_fingerprint([filename],('Moon','星海'),str(tmp_path))
    evidence=[{'path':Path(filename).name,'quote':correction if valid_evidence else '不存在的纠正'}]
    response={'topic':'星海','summary':'纠正后的记录',
              'aliases':['Moon'],
              'related_entities':[{'name':'月白','relation':'角色','exclusive':True,'evidence':evidence}],
              'mapping_removals':[
                  {'kind':'alias','name':'Moon','reason':'用户明确纠正','evidence':evidence},
                  {'kind':'entity','name':'月白','reason':'用户明确纠正','evidence':evidence},
              ]}
    assert await memory._build_topic_card(topic='星海',files=[filename],fingerprint=fp,
                                         topic_dir=topics,summarize=AsyncMock(return_value=json.dumps(response,ensure_ascii=False)),
                                         diary_root=str(tmp_path))
    saved=json.loads(memory._topic_path(topics,'星海').read_text(encoding="utf-8"))
    assert 'mapping_removals' not in saved
    assert bool(saved['aliases']) is not valid_evidence
    assert bool(saved['related_entities']) is not valid_evidence


@pytest.mark.parametrize('action,candidate,body',[
    ('entity','月白','月白是星海的专属角色。'),
    ('alias','Star Ocean','Star Ocean就是星海。'),
])
async def test_legacy_parent_upgrades_before_candidate_is_attached(tmp_path,action,candidate,body):
    hook=memory.ActiveMemoryHook(str(tmp_path),tmp_path)
    card(hook._topic_dir,schema_version=5)
    old=note(tmp_path,date='2025-01-01',body='星海很早以前的记录。')
    files=[note(tmp_path,date=f'2026-01-{i:02d}',body=body) for i in range(1,6)]
    fp=memory._topic_fingerprint(files,(candidate,),str(tmp_path))
    review=json.dumps({'action':action,'target':'星海','reason':'原文明确','relation':'角色',
                       'evidence':[{'path':Path(files[0]).name,'quote':body}]},ensure_ascii=False)
    model=AsyncMock(side_effect=[review,'{"topic":"星海","summary":"完整父主题历史"}',review])
    scheduled=[]
    hook.configure_topic_summary(model,scheduled.append)
    hook._maybe_schedule_topic_card(candidate,files,fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    assert model.await_count==3
    assert Path(old).name in model.call_args_list[1].args[0]
    saved=memory._find_topic_card(hook._topic_dir,candidate.split())
    assert saved['schema_version']==7
    assert saved['summary']=='完整父主题历史'
    assert '2025-01-01' in saved['sources']
    assert not list((hook._topic_dir/'retries').glob('*.json'))


async def test_failed_legacy_upgrade_preserves_old_card_and_does_not_cache_link(tmp_path):
    hook=memory.ActiveMemoryHook(str(tmp_path),tmp_path)
    original=card(hook._topic_dir,schema_version=5)
    filename=note(tmp_path,body='月白是星海的角色。')
    fp=memory._topic_fingerprint([filename],('月白',),str(tmp_path))
    model=AsyncMock(side_effect=[json.dumps({
        'action':'entity','target':'星海','reason':'原文明确','relation':'角色',
        'evidence':[{'path':Path(filename).name,'quote':'月白是星海的角色。'}],
    },ensure_ascii=False),RuntimeError('upgrade unavailable')])
    scheduled=[]
    hook.configure_topic_summary(model,scheduled.append)
    hook._maybe_schedule_topic_card('月白',[filename],fp)
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled.pop()
    assert json.loads(memory._topic_path(hook._topic_dir,'星海').read_text(encoding="utf-8"))==original
    assert not memory._topic_decision_path(hook._topic_dir,'月白').exists()


async def test_corrupt_diary_keeps_healthy_hits_without_scheduling_rebuild(tmp_path,monkeypatch):
    good=note(tmp_path,date='2026-01-02')
    bad=tmp_path/'2026-01-01.md'
    bad.write_bytes('星海'.encode()+b'\xff')
    hook=memory.ActiveMemoryHook(str(tmp_path),tmp_path)
    card(hook._topic_dir)
    monkeypatch.setattr(memory,'_grep_files',lambda *_args:{good,str(bad)})
    monkeypatch.setattr(hook,'_extract_keywords',AsyncMock(return_value='星海'))
    result=memory._search_diary('星海',str(tmp_path),hook._topic_dir)
    assert not result.source_complete
    assert [h['date'] for h in result.hits]==['2026-01-02']
    scheduled=[]
    hook.configure_topic_summary(AsyncMock(),scheduled.append)
    message={'role':'user','content':'继续说说星海的故事'}
    await hook.before_iteration(AgentHookContext(iteration=0,messages=[message]))
    assert '2026-01-02' in message['content']
    await hook.on_finally(AgentRunHookContext(messages=[]))
    assert message['content'] == '继续说说星海的故事'
    assert not scheduled






async def test_rebuild_can_refine_a_confirmed_relation_with_new_evidence(tmp_path):
    body='月白是星海的公会，不是角色。'
    filename=note(tmp_path,body=body)
    topics=tmp_path/'topics'
    card(topics,related_entities=[{'name':'月白','relation':'角色','sources':[Path(filename).name]}])
    fp=memory._topic_fingerprint([filename],('星海',),str(tmp_path))
    response={'topic':'星海','summary':'修正关系','related_entities':[{
        'name':'月白','relation':'专属公会','exclusive':True,
        'evidence':[{'path':Path(filename).name,'quote':body}],
    }]}
    assert await memory._build_topic_card(topic='星海',files=[filename],fingerprint=fp,
                                         topic_dir=topics,summarize=AsyncMock(return_value=json.dumps(response,ensure_ascii=False)),
                                         diary_root=str(tmp_path))
    updated=memory._find_topic_card(topics,['月白'])
    assert updated['_matched_related_entities'][0]['relation']=='专属公会'


def test_partial_scan_keeps_hits_but_disables_card_generation(tmp_path,monkeypatch):
    import subprocess
    from types import SimpleNamespace
    filename=note(tmp_path)
    monkeypatch.setattr(subprocess,'run',lambda *_args,**_kwargs: SimpleNamespace(
        returncode=2,stdout=filename+'\n',stderr='another file: permission denied',
    ))
    result=memory._search_diary('星海',str(tmp_path))
    assert not result.source_complete
    assert len(result.hits)==1
    assert result.topic is None


def test_one_failed_keyword_does_not_drop_other_keyword_hits(tmp_path,monkeypatch):
    filename=note(tmp_path)
    def scan(word,root):
        if word=='月白':
            raise OSError('scan unavailable')
        return {filename}
    monkeypatch.setattr(memory,'_grep_files',scan)
    result=memory._search_diary('星海 月白',str(tmp_path))
    assert not result.source_complete
    assert len(result.hits)==1
    assert result.hits[0]['matched']==['星海']
