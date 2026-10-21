"""主题卡维护回归：泛化词预筛、单字过滤、dirty 队列与定时批量。"""

import asyncio
import json
from unittest.mock import AsyncMock

from nanobot.agent import active_memory as memory


def note(root, date="2026-01-01", body="中午吃了青椒炒肉。"):
    path = root / f"{date} 周一.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n概要: {date}记录\n心情: 平淡\n---\n\n{body}\n", encoding="utf-8")
    return str(path)


def card(root, topic="星海", **extra):
    data = {"schema_version": memory.TOPIC_CARD_SCHEMA_VERSION, "topic": topic, "aliases": [],
            "summary": "旧摘要", "related_entities": [], **extra}
    memory._write_json(memory._topic_path(root, topic), data)
    return data


def hook_with(tmp_path, diary_root):
    return memory.ActiveMemoryHook(str(diary_root), workspace=str(tmp_path))


# ── 单字词过滤 ─────────────────────────────────────────


def test_single_char_keyword_rejected_unless_known(tmp_path):
    card(tmp_path, "星海", aliases=["焰"])
    result, rejected = memory._validate_keywords("焰 第 星海", "焰又出场了，星海更新了", tmp_path)
    assert "焰" in result
    assert "星海" in result
    assert "第" not in result
    assert "第" in rejected


def test_single_char_entity_from_card_kept(tmp_path):
    # known 名称包含 related_entities 中的单字实体
    card(tmp_path, "星海", related_entities=[
        {"name": "月", "relation": "专属角色", "sources": ["2026-01-01 周一.md"]}])
    result, _ = memory._validate_keywords("月 星海", "星海的月又登场", tmp_path)
    assert "月" in result


def test_single_char_not_in_known_rejected(tmp_path):
    result, rejected = memory._validate_keywords("点 星海", "晚上八点聊星海", tmp_path)
    assert "点" not in result
    assert "点" in rejected
    assert "星海" in result


# ── 泛化词预筛 ─────────────────────────────────────────


def test_generic_term_prefiltered_in_search(tmp_path):
    for i in range(6):
        note(tmp_path, date=f"2026-0{i + 1}-0{i + 1}")
    result = memory._search_diary("中午", str(tmp_path))
    assert result.topic is None
    assert result.prefiltered_generic == ["中午"]
    # 普通片段召回不受预筛影响
    assert len(result.hits) >= 1


def test_non_generic_topic_still_discovers(tmp_path):
    for i in range(6):
        note(tmp_path, date=f"2026-0{i + 1}-0{i + 1}", body="星海更新了新版本。")
    result = memory._search_diary("星海", str(tmp_path))
    assert result.topic == "星海"
    assert not result.prefiltered_generic


# ── dirty 队列 ─────────────────────────────────────────


def test_maybe_schedule_writes_dirty_marker(tmp_path):
    diary = tmp_path / "diary"
    diary.mkdir()
    hook = hook_with(tmp_path, diary)
    hook._maybe_schedule_topic_card("鸣潮", ["a.md"], "fp-1", request_id="r1")
    dirty = tmp_path / "memory" / "active_memory_topics" / "dirty" / f"{memory._topic_key('鸣潮')}.json"
    assert dirty.exists()
    data = json.loads(dirty.read_text(encoding="utf-8"))
    assert data["topic"] == "鸣潮"
    assert data["fingerprint"] == "fp-1"
    assert data["files"] == ["a.md"]
    # 同指纹幂等：不重复写（时间戳不变）
    first = dirty.read_text(encoding="utf-8")
    hook._maybe_schedule_topic_card("鸣潮", ["a.md"], "fp-1", request_id="r2")
    assert dirty.read_text(encoding="utf-8") == first
    # 新指纹覆盖旧标记
    hook._maybe_schedule_topic_card("鸣潮", ["a.md", "b.md"], "fp-2", request_id="r3")
    assert json.loads(dirty.read_text(encoding="utf-8"))["fingerprint"] == "fp-2"


def test_maybe_schedule_prefilters_generic(tmp_path):
    diary = tmp_path / "diary"
    diary.mkdir()
    hook = hook_with(tmp_path, diary)
    hook._maybe_schedule_topic_card("中午", ["a.md"], "fp-1")
    dirty_dir = tmp_path / "memory" / "active_memory_topics" / "dirty"
    assert not dirty_dir.exists() or not list(dirty_dir.glob("*.json"))
    log = tmp_path / "memory" / "topic_cards.jsonl"
    assert log.exists()
    lines = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert any(entry.get("reason") == "prefiltered_generic" for entry in lines)


# ── 批量处理 ─────────────────────────────────────────


def test_process_dirty_topics_unconfigured_returns_empty(tmp_path):
    diary = tmp_path / "diary"
    diary.mkdir()
    hook = hook_with(tmp_path, diary)
    hook._maybe_schedule_topic_card("鸣潮", ["a.md"], "fp-1")
    stats = asyncio.run(hook.process_dirty_topics())
    assert stats == {"total": 0, "processed": 0, "failed": 0}
    # 未配置 summarize：dirty 标记保留，等待下次
    dirty = tmp_path / "memory" / "active_memory_topics" / "dirty"
    assert list(dirty.glob("*.json"))


def test_process_dirty_topics_runs_and_cleans(tmp_path):
    diary = tmp_path / "diary"
    diary.mkdir()
    hook = hook_with(tmp_path, diary)
    scheduled = []
    hook.configure_topic_summary(AsyncMock(return_value=""), scheduled.append)
    hook._maybe_schedule_topic_card("鸣潮", ["a.md"], "fp-1")
    hook._maybe_schedule_topic_card("葱爆牛肉", ["b.md"], "fp-2")
    hook._build_topic_task = AsyncMock()  # 批量只负责调度与清理，判定逻辑单测覆盖
    stats = asyncio.run(hook.process_dirty_topics())
    assert stats["total"] == 2
    assert stats["processed"] == 2
    assert stats["failed"] == 0
    dirty = tmp_path / "memory" / "active_memory_topics" / "dirty"
    assert not list(dirty.glob("*.json"))
    # 再次调用幂等空转
    stats2 = asyncio.run(hook.process_dirty_topics())
    assert stats2 == {"total": 0, "processed": 0, "failed": 0}
    for coro in scheduled:
        coro.close()


def test_process_dirty_topics_skips_malformed_markers(tmp_path):
    diary = tmp_path / "diary"
    diary.mkdir()
    hook = hook_with(tmp_path, diary)
    scheduled = []
    hook.configure_topic_summary(AsyncMock(return_value=""), scheduled.append)
    hook._maybe_schedule_topic_card("鸣潮", ["a.md"], "fp-1")
    hook._build_topic_task = AsyncMock()
    dirty_dir = tmp_path / "memory" / "active_memory_topics" / "dirty"
    (dirty_dir / "broken.json").write_text("{not-json", encoding="utf-8")
    (dirty_dir / "empty.json").write_text("{}", encoding="utf-8")
    stats = asyncio.run(hook.process_dirty_topics())
    assert stats["processed"] == 1  # 只有合法标记被处理
    assert not list(dirty_dir.glob("*.json"))  # 损坏标记也被清理
    for coro in scheduled:
        coro.close()


# ── 懒触发批量 ─────────────────────────────────────────


def test_maybe_trigger_batch_schedules_once_when_dirty(tmp_path):
    diary = tmp_path / "diary"
    diary.mkdir()
    hook = hook_with(tmp_path, diary)
    scheduled = []
    hook.configure_topic_summary(AsyncMock(return_value=""), scheduled.append)
    # dirty 后首次触发：调度一次
    hook._maybe_schedule_topic_card("鸣潮", ["a.md"], "fp-1")
    assert len(scheduled) == 1
    # 批量在跑（batch_running 置位）：新指纹 dirty 不再重复调度
    hook._maybe_schedule_topic_card("鸣潮", ["a.md", "b.md"], "fp-2")
    assert len(scheduled) == 1
    for coro in scheduled:
        coro.close()
    # 标志复位但间隔未到（无 stamp 时视为从未跑过？需 stamp 兜底检查）
    hook._batch_running[0] = False
    hook._maybe_trigger_batch()
    assert len(scheduled) == 2  # 无 stamp → 视为可跑，再次调度
    for coro in scheduled:
        coro.close()


def test_maybe_trigger_batch_respects_stamp_interval(tmp_path):
    from datetime import datetime, timedelta

    diary = tmp_path / "diary"
    diary.mkdir()
    hook = hook_with(tmp_path, diary)
    scheduled = []
    hook.configure_topic_summary(AsyncMock(return_value=""), scheduled.append)
    stamp = tmp_path / "memory" / "active_memory_topics" / "maintenance.stamp"
    stamp.parent.mkdir(parents=True, exist_ok=True)
    # stamp 是刚写的 → 间隔内不触发
    stamp.write_text(datetime.now(memory.SHANGHAI).isoformat(), encoding="utf-8")
    hook._maybe_schedule_topic_card("鸣潮", ["a.md"], "fp-1")
    assert not scheduled
    # stamp 是 25 小时前 → 触发
    stamp.write_text((datetime.now(memory.SHANGHAI) - timedelta(hours=25)).isoformat(), encoding="utf-8")
    hook._maybe_schedule_topic_card("鸣潮", ["a.md", "b.md"], "fp-2")
    assert len(scheduled) == 1
    for coro in scheduled:
        coro.close()
