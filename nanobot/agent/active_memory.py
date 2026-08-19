"""ActiveMemory hook：自动记忆召回。

用户发消息时，用 NAS 上的 Ollama 微调模型提取关键词，
grep 搜日记，把结果注入上下文。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from nanobot.agent.hook import AgentHook, AgentHookContext, AgentRunHookContext

# ── 配置 ──────────────────────────────────────────────

OLLAMA_URL = "http://192.168.31.73:11434/api/chat"
OLLAMA_MODEL = "active-memory:1.7b"
OLLAMA_TIMEOUT = 6.0  # 秒，超时静默跳过

MAX_RESULTS = 10
RECENT_RESULTS_WITHOUT_CARD = 6
HISTORICAL_RESULTS_WITHOUT_CARD = 4
TOPIC_THRESHOLD = 20
ACTIVE_MEMORY_LOG_MAX_BYTES = 5 * 1024 * 1024

SHANGHAI = timezone(timedelta(hours=8))

SYSTEM_PROMPT = """你是日记检索数据标注员。只从用户消息原文复制最多5个搜索词，覆盖所有人名、作品名、地点名、事件名、食物名、物品名；剧情、到货、预购等限定词仅在原文出现时提取。否定、取消、推迟不影响实体提取。排除操作动词、文件路径、代码标识符、软件开发术语、问候、确认及无具体指代的词。禁止输出原文没有的词，禁止改写。以空格分隔；没有则只输出无，不要解释。"""


# ── 核心 ──────────────────────────────────────────────


class ActiveMemoryHook(AgentHook):
    """自动记忆召回 hook。"""

    def __init__(self, diary_root: str = "", workspace: str | Path | None = None) -> None:
        self._diary_root = diary_root
        self._log_path = Path(workspace) / "memory" / "active_memory.jsonl" if workspace else None
        self._topic_dir = Path(workspace) / "memory" / "active_memory_topics" if workspace else None
        self._summarize: Callable[[str], Awaitable[str]] | None = None
        self._schedule: Callable[[Awaitable[Any]], None] | None = None
        self._topic_tasks: set[str] = set()
        self._pending_topic_cards: dict[str, tuple[str, list[str], str, tuple[str, ...]]] = {}

    def configure_topic_summary(
        self,
        summarize: Callable[[str], Awaitable[str]],
        schedule: Callable[[Awaitable[Any]], None],
    ) -> None:
        """注入无工具的主模型摘要调用与 AgentLoop 后台调度器。"""
        self._summarize = summarize
        self._schedule = schedule

    async def before_iteration(self, context: AgentHookContext) -> None:
        # 只在第一轮处理
        if context.iteration > 0 or not self._diary_root:
            return

        # 取最新的用户消息
        user_msg = next(
            (m for m in reversed(context.messages) if m.get("role") == "user"),
            None,
        )
        if not user_msg:
            return

        text = _extract_text(user_msg.get("content", ""))
        if not text or len(text) < 5:
            return

        t_start = time.monotonic()
        log_entry: dict[str, Any] = {
            "timestamp": datetime.now(SHANGHAI).isoformat(),
            "text_preview": text[:80],
        }

        # Step 1: Ollama 提取关键词
        t0 = time.monotonic()
        try:
            keywords = await asyncio.wait_for(
                self._extract_keywords(text),
                timeout=OLLAMA_TIMEOUT,
            )
        except asyncio.TimeoutError:
            log_entry["action"] = "skip_timeout"
            _log(self._log_path, log_entry, int((time.monotonic() - t_start) * 1000), 0)
            return
        except Exception:
            log_entry["action"] = "skip_error"
            _log(self._log_path, log_entry, int((time.monotonic() - t_start) * 1000), 0)
            return

        model_ms = int((time.monotonic() - t0) * 1000)
        log_entry["keywords"] = keywords
        log_entry["model_ms"] = model_ms

        if not keywords or keywords == "无":
            log_entry["action"] = "skip_no_keywords"
            _log(self._log_path, log_entry, int((time.monotonic() - t_start) * 1000), 0)
            return

        # Step 2: grep 搜日记
        t1 = time.monotonic()
        search = await asyncio.to_thread(
            _search_diary,
            keywords,
            self._diary_root,
            self._topic_dir,
        )
        hits = search.hits
        search_ms = int((time.monotonic() - t1) * 1000)

        log_entry["search_ms"] = search_ms
        log_entry["files"] = [h["date"] for h in hits]
        log_entry["candidate_count"] = len(search.candidates)
        log_entry["topic"] = search.topic
        log_entry["topic_card"] = "hit" if search.topic_card else "miss"

        if not hits:
            log_entry["action"] = "skip_no_results"
            _log(self._log_path, log_entry, int((time.monotonic() - t_start) * 1000), search_ms)
            return

        # Step 3: 作为参考数据追加到当前 user 消息尾部
        injection = _format_injection(hits, search.topic_card)
        user_msg["content"] = _append_reference(user_msg.get("content"), injection)
        log_entry["action"] = "injected"
        log_entry["injection_chars"] = len(injection)

        if search.topic and search.topic_files:
            self._maybe_schedule_topic_card(
                search.topic,
                search.topic_files,
                search.fingerprint,
                force=search.force_topic_update,
                evidence_terms=search.topic_evidence_terms,
            )

        total_ms = int((time.monotonic() - t_start) * 1000)
        _log(self._log_path, log_entry, total_ms, search_ms)

    async def _extract_keywords(self, text: str) -> str:
        """调用 NAS Ollama 微调模型提取关键词。"""
        async with httpx.AsyncClient() as client:
            resp = await client.post(OLLAMA_URL, json={
                "model": OLLAMA_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": text},
                ],
                "think": False,
                "options": {
                    "temperature": 0,
                    "num_ctx": 1024,
                    "num_predict": 30,
                    "seed": 42,
                },
                "stream": False,
                "keep_alive": -1,
            })
            resp.raise_for_status()
            data = resp.json()
            return (data.get("message", {}).get("content") or "").strip().replace("\n", " ")

    async def on_finally(self, context: AgentRunHookContext) -> None:
        """当前回复结束后再启动摘要，避免与用户请求争用主模型。"""
        pending = list(self._pending_topic_cards.values())
        self._pending_topic_cards.clear()
        for topic, files, fingerprint, evidence_terms in pending:
            self._schedule_topic_card(topic, files, fingerprint, evidence_terms)

    def _maybe_schedule_topic_card(
        self,
        topic: str,
        files: list[str],
        fingerprint: str,
        *,
        force: bool = False,
        evidence_terms: tuple[str, ...] = (),
    ) -> None:
        if not self._topic_dir or not self._summarize or not self._schedule:
            return
        card = _find_topic_card(self._topic_dir, [topic])
        if not force and card and card.get("fingerprint") == fingerprint:
            return
        key = _topic_key(topic)
        if key in self._topic_tasks or key in self._pending_topic_cards:
            return
        self._pending_topic_cards[key] = (topic, files, fingerprint, evidence_terms)

    def _schedule_topic_card(
        self,
        topic: str,
        files: list[str],
        fingerprint: str,
        evidence_terms: tuple[str, ...] = (),
    ) -> None:
        if not self._topic_dir or not self._summarize or not self._schedule:
            return
        key = _topic_key(topic)
        self._topic_tasks.add(key)

        async def build() -> None:
            started = time.monotonic()
            try:
                updated = await _build_topic_card(
                    topic=topic,
                    files=files,
                    fingerprint=fingerprint,
                    topic_dir=self._topic_dir,
                    summarize=self._summarize,
                    evidence_terms=evidence_terms,
                )
                _log(self._log_path, {
                    "action": "topic_card_updated" if updated else "topic_card_skipped",
                    "topic": topic,
                    "source_count": len(files),
                }, int((time.monotonic() - started) * 1000), 0)
            except Exception as exc:
                _log(self._log_path, {
                    "action": "topic_card_error",
                    "topic": topic,
                    "error": f"{type(exc).__name__}: {exc}"[:300],
                }, int((time.monotonic() - started) * 1000), 0)
            finally:
                self._topic_tasks.discard(key)

        self._schedule(build())


# ── 搜索 ──────────────────────────────────────────────


@dataclass(slots=True)
class DiaryCandidate:
    path: str
    date: str
    matched: tuple[str, ...]
    summary: str
    summary_hits: int
    frequency: int


@dataclass(slots=True)
class DiarySearchResult:
    hits: list[dict[str, Any]]
    candidates: list[DiaryCandidate]
    topic: str | None = None
    topic_files: list[str] | None = None
    fingerprint: str = ""
    topic_card: dict[str, Any] | None = None
    force_topic_update: bool = False
    topic_evidence_terms: tuple[str, ...] = ()


def _grep_diary(keywords: str, diary_root: str = "") -> list[dict[str, Any]]:
    """兼容入口：返回 Active Memory 最终日记结果。"""
    return _search_diary(keywords, diary_root).hits


def _search_diary(
    keywords: str,
    diary_root: str = "",
    topic_dir: Path | None = None,
) -> DiarySearchResult:
    """并行搜每个关键词，按覆盖数与概要命中稳定排序。"""
    if not diary_root:
        return DiarySearchResult([], [])
    words = [w for w in keywords.split() if w]
    if not words:
        return DiarySearchResult([], [])

    with ThreadPoolExecutor(max_workers=min(len(words), 5)) as executor:
        sets = list(executor.map(lambda word: _grep_files(word, diary_root), words))
    matched_by_file: dict[str, list[str]] = defaultdict(list)
    for word, files in zip(words, sets, strict=True):
        for path in files:
            matched_by_file[path].append(word)

    candidates: list[DiaryCandidate] = []
    for path, matched in matched_by_file.items():
        try:
            content = Path(path).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        summary = _extract_summary(content)
        candidates.append(DiaryCandidate(
            path=path,
            date=Path(path).name[:10],
            matched=tuple(matched),
            summary=summary,
            summary_hits=sum(1 for word in matched if word in summary),
            frequency=sum(min(content.count(word), 9) for word in matched),
        ))

    candidates.sort(
        key=lambda item: (
            len(item.matched),
            item.summary_hits,
            item.date,
            item.frequency,
        ),
        reverse=True,
    )
    ranked = _diversify_candidates(candidates, words)

    topic_card = _find_topic_card(topic_dir, words) if topic_dir else None
    inferred_topic_files: set[str] | None = None
    inferred_term: str | None = None
    if topic_dir and not topic_card:
        inferred = _infer_parent_topic_card(
            topic_dir,
            words,
            sets,
            diary_root,
        )
        if inferred:
            topic_card, inferred_topic_files, inferred_term = inferred
    if topic_card:
        topic = str(topic_card["topic"])
        names = {topic, *(str(alias) for alias in topic_card.get("aliases") or [])}
        related_sets = [files for word, files in zip(words, sets, strict=True) if word in names]
        canonical_files = inferred_topic_files or (
            sets[words.index(topic)]
            if topic in words
            else _grep_files(topic, diary_root)
        )
        topic_files = sorted(
            canonical_files
            or (set().union(*related_sets) if related_sets else sets[0])
        )
    else:
        eligible = [
            (len(files), index)
            for index, files in enumerate(sets)
            if len(files) >= TOPIC_THRESHOLD
        ]
        topic_index = min(eligible)[1] if eligible else None
        topic = words[topic_index] if topic_index is not None else None
        topic_files = sorted(sets[topic_index]) if topic_index is not None else None
    fingerprint = _topic_fingerprint(topic_files or [])
    if topic_card:
        ranked = sorted(candidates, key=lambda item: item.date, reverse=True)
    elif topic:
        ranked = _time_stratified_candidates(ranked)

    results: list[dict[str, Any]] = []
    selected_paths: set[str] = set()
    for item in [*ranked, *candidates]:
        if item.path in selected_paths:
            continue
        selected_paths.add(item.path)
        snippet = _candidate_snippet(item, words)
        if snippet:
            results.append({
                "date": item.date,
                "snippet": snippet,
                "path": Path(item.path).name,
                "matched": list(item.matched),
                "match_count": len(item.matched),
            })
        if len(results) >= MAX_RESULTS:
            break

    return DiarySearchResult(
        hits=results,
        candidates=candidates,
        topic=topic,
        topic_files=topic_files,
        fingerprint=fingerprint,
        topic_card=topic_card,
        force_topic_update=inferred_term is not None,
        topic_evidence_terms=(inferred_term,) if inferred_term else (),
    )


def _extract_summary(content: str) -> str:
    match = re.search(r"(?m)^概要:\s*(.+?)\s*$", content)
    return match.group(1).strip() if match else ""


def _extract_topic_evidence(content: str, terms: str | tuple[str, ...]) -> str:
    """提取 topic/新关联词命中行及前后各一行；不截断。"""
    lines = content.splitlines()
    selected: list[str] = []
    seen: set[int] = set()
    needles = tuple(term.casefold() for term in ((terms,) if isinstance(terms, str) else terms))
    for index, line in enumerate(lines):
        folded = line.casefold()
        if not any(needle in folded for needle in needles):
            continue
        for nearby in range(max(0, index - 1), min(len(lines), index + 2)):
            if nearby in seen:
                continue
            text = lines[nearby].strip()
            if text and text not in {"---", "--"}:
                selected.append(text)
                seen.add(nearby)
    return "\n".join(selected)


def _candidate_snippet(item: DiaryCandidate, words: list[str]) -> str:
    body = _extract_snippet(item.path, words)
    if item.summary:
        return f"概要：{item.summary}；{body}"[:200] if body else f"概要：{item.summary}"[:200]
    return body


def _diversify_candidates(
    candidates: list[DiaryCandidate],
    words: list[str],
) -> list[DiaryCandidate]:
    if len(words) < 2 or any(len(item.matched) == len(words) for item in candidates):
        return list(candidates)
    selected: list[DiaryCandidate] = []
    seen: set[str] = set()
    for word in words:
        item = next((candidate for candidate in candidates if word in candidate.matched), None)
        if item and item.path not in seen:
            selected.append(item)
            seen.add(item.path)
    return [*selected, *(item for item in candidates if item.path not in seen)]


def _time_stratified_candidates(candidates: list[DiaryCandidate]) -> list[DiaryCandidate]:
    recent = sorted(candidates, key=lambda item: item.date, reverse=True)[
        :RECENT_RESULTS_WITHOUT_CARD
    ]
    recent_paths = {item.path for item in recent}
    best_historical = next(
        (item for item in candidates if item.path not in recent_paths),
        None,
    )
    buckets: dict[str, DiaryCandidate] = {}
    for item in candidates:
        if item.path in recent_paths or item is best_historical:
            continue
        if len(item.date) < 7:
            continue
        month = int(item.date[5:7]) if item.date[5:7].isdigit() else 1
        key = f"{item.date[:4]}-Q{(month - 1) // 3 + 1}"
        buckets.setdefault(key, item)
    representatives = [buckets[key] for key in sorted(buckets, reverse=True)]
    remaining_slots = HISTORICAL_RESULTS_WITHOUT_CARD - int(best_historical is not None)
    if len(representatives) > remaining_slots:
        last = len(representatives) - 1
        representatives = [
            representatives[round(i * last / max(1, remaining_slots - 1))]
            for i in range(remaining_slots)
        ]
    selected = [*recent, *([best_historical] if best_historical else []), *representatives]
    selected_paths = {item.path for item in selected}
    return [*selected, *(item for item in candidates if item.path not in selected_paths)]


def _grep_files(word: str, root: str = "") -> set[str]:
    """优先 use ripgrep literal search，缺失时回退 grep。"""
    if not root:
        return set()
    try:
        rg = shutil.which("rg")
        command = (
            [rg, "-l", "-F", "-g", "*.md", word, root]
            if rg
            else ["grep", "-rl", "--include=*.md", word, root]
        )
        r = subprocess.run(
            command,
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0 and r.stdout.strip():
            return {f for f in r.stdout.strip().split("\n") if f.strip()}
    except Exception:
        pass
    return set()


def _extract_snippet(filepath: str, words: list[str]) -> str:
    """提取匹配行±1行上下文，过滤概要行。"""
    pattern = "|".join(re.escape(w) for w in words)
    try:
        r = subprocess.run(
            ["grep", "-m", "3", "-B", "1", "-A", "1", "-E", pattern, filepath],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0 or not r.stdout:
            return ""
        lines = r.stdout.strip().split("\n")
        # 过滤概要行和分隔线
        cleaned = [
            line for line in lines
            if not line.strip().startswith("概要:")
            and line.strip() not in ("---", "--", "")
        ]
        return " ".join(cleaned)[:200]
    except Exception:
        return ""


# ── 主题摘要卡 ────────────────────────────────────────


def _topic_key(topic: str) -> str:
    return hashlib.sha256(topic.encode("utf-8")).hexdigest()[:20]


def _topic_path(topic_dir: Path, topic: str) -> Path:
    return topic_dir / f"{_topic_key(topic)}.json"


def _load_topic_cards(topic_dir: Path | None) -> list[dict[str, Any]]:
    if topic_dir is None or not topic_dir.is_dir():
        return []
    cards = []
    for path in topic_dir.glob("*.json"):
        try:
            card = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(card, dict) and card.get("topic"):
            cards.append(card)
    return cards


def _find_topic_card(topic_dir: Path | None, words: list[str]) -> dict[str, Any] | None:
    wanted = {word.casefold() for word in words}

    def matched_count(names: set[str]) -> int:
        return sum(
            1
            for name in names
            if name and set(name.casefold().split()) <= wanted
        )

    best: tuple[tuple[int, int, int], dict[str, Any]] | None = None
    for card in _load_topic_cards(topic_dir):
        topic_names = {str(card["topic"])}
        alias_names = {str(alias) for alias in card.get("aliases") or []}
        related_names = {
            str(entity.get("name"))
            for entity in card.get("related_entities") or []
            if isinstance(entity, dict) and entity.get("name")
        }
        topic_overlap = matched_count(topic_names)
        alias_overlap = matched_count(alias_names)
        related_overlap = matched_count(related_names)
        match_kind = "topic" if topic_overlap else "alias" if alias_overlap else "related"
        overlap = topic_overlap or alias_overlap or related_overlap
        if overlap == 0:
            continue
        rank = (
            3 if match_kind == "topic" else 2 if match_kind == "alias" else 1,
            overlap,
            int(card.get("source_count") or 0),
        )
        if best is None or rank > best[0]:
            matched = dict(card)
            matched["_match_kind"] = match_kind
            best = (rank, matched)
    return best[1] if best else None


def _infer_parent_topic_card(
    topic_dir: Path,
    words: list[str],
    word_sets: list[set[str]],
    diary_root: str,
) -> tuple[dict[str, Any], set[str], str] | None:
    """未知实体与已有主题在同篇日记共现时，关联父主题而非新建平级卡。"""
    best: tuple[tuple[float, int, int], dict[str, Any], set[str], str] | None = None
    for card in _load_topic_cards(topic_dir):
        topic = str(card["topic"])
        topic_files = _grep_files(topic, diary_root)
        if not topic_files:
            continue
        for word, files in zip(words, word_sets, strict=True):
            if not files:
                continue
            overlap = topic_files & files
            evidenced = len(overlap)
            if evidenced == 0:
                continue
            rank = (evidenced / len(files), evidenced, int(card.get("source_count") or 0))
            if best is None or rank > best[0]:
                matched = dict(card)
                matched["_match_kind"] = "inferred_related"
                best = (rank, matched, topic_files, word)
    return (best[1], best[2], best[3]) if best else None


def _topic_fingerprint(files: list[str]) -> str:
    digest = hashlib.sha256()
    for filename in files:
        try:
            stat = Path(filename).stat()
        except OSError:
            continue
        digest.update(f"{filename}\0{stat.st_mtime_ns}\0{stat.st_size}\n".encode())
    return digest.hexdigest()


async def _build_topic_card(
    *,
    topic: str,
    files: list[str],
    fingerprint: str,
    topic_dir: Path,
    summarize: Callable[[str], Awaitable[str]],
    evidence_terms: tuple[str, ...] = (),
) -> bool:
    entries: list[tuple[str, str, str]] = []
    for filename in files:
        try:
            content = await asyncio.to_thread(
                Path(filename).read_text,
                encoding="utf-8",
                errors="ignore",
            )
        except OSError:
            continue
        summary = _extract_summary(content)
        if summary:
            entries.append((
                Path(filename).name[:10],
                summary,
                _extract_topic_evidence(content, (topic, *evidence_terms)),
            ))
    if not entries:
        return False
    entries.sort()
    source = "\n\n".join(
        f"[{date}]\n概要：{summary}"
        + (f"\n正文证据：\n{evidence}" if evidence else "")
        for date, summary, evidence in entries
    )
    prompt = (
        "你是长期日记主题整理器。根据按日期排列的日记概要，整理主题的长期脉络。"
        "保留重要阶段、态度变化、关键事件与时间，不编造；输出简洁中文 Markdown，"
        "区分同义别名与主题内相关实体。相关实体必须在下方概要或正文证据中实际出现，"
        "并给出关系类型与支持日期。只输出 JSON："
        '{"topic":"规范主题名","aliases":["同义名"],'
        '"related_entities":[{"name":"实体","relation":"角色/地点/组织/事件/物品",'
        '"source_dates":["YYYY-MM-DD"]}],"summary":"Markdown摘要"}。\n\n'
        f"主题：{topic}\n日期范围：{entries[0][0]} 至 {entries[-1][0]}\n\n{source}"
    )
    raw = (await summarize(prompt)).strip()
    generated: Any = None
    with suppress(json.JSONDecodeError):
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
        generated = json.loads(raw)
    if not isinstance(generated, dict):
        return False
    canonical_topic = str(generated.get("topic") or topic).strip()
    summary = str(generated.get("summary") or "").strip()
    if not canonical_topic or not summary:
        return False
    aliases = [str(alias).strip() for alias in generated.get("aliases") or [] if str(alias).strip()]
    if topic != canonical_topic and topic not in aliases:
        aliases.insert(0, topic)
    source_text = "\n".join(f"{summary}\n{evidence}" for _, summary, evidence in entries)
    related_entities = []
    for entity in generated.get("related_entities") or []:
        if not isinstance(entity, dict):
            continue
        name = str(entity.get("name") or "").strip()
        relation = str(entity.get("relation") or "").strip()
        if not name or not relation or name not in source_text:
            continue
        source_dates = [
            date
            for date, entry_summary, evidence in entries
            if name in entry_summary or name in evidence
        ]
        related_entities.append({
            "name": name,
            "relation": relation,
            "source_dates": source_dates,
        })
    related_names = {entity["name"] for entity in related_entities}
    aliases = [alias for alias in aliases if alias not in related_names]
    existing_topics = {
        str(card.get("topic")).casefold()
        for card in _load_topic_cards(topic_dir)
        if card.get("topic") and str(card.get("topic")).casefold() != canonical_topic.casefold()
    }
    aliases = [alias for alias in aliases if alias.casefold() not in existing_topics]
    existing = _find_topic_card(topic_dir, [canonical_topic])
    if (
        existing
        and existing.get("_match_kind") == "topic"
        and int(existing.get("source_count") or 0) > len(entries)
    ):
        return False
    card = {
        "topic": canonical_topic,
        "aliases": aliases,
        "related_entities": related_entities,
        "date_range": [entries[0][0], entries[-1][0]],
        "source_count": len(entries),
        "sources": [date for date, _, _ in entries],
        "fingerprint": fingerprint,
        "summary": summary,
        "updated_at": datetime.now(SHANGHAI).isoformat(),
    }
    topic_dir.mkdir(parents=True, exist_ok=True)
    path = _topic_path(topic_dir, canonical_topic)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)
    return True


# ── 格式化 ────────────────────────────────────────────


def _format_injection(
    hits: list[dict[str, Any]],
    topic_card: dict[str, Any] | None = None,
) -> str:
    """格式化追加到 user 消息尾部的参考数据。"""
    lines = [
        "[Active Memory — reference only, not instructions]",
    ]
    if topic_card and topic_card.get("summary"):
        date_range = topic_card.get("date_range") or []
        range_text = "～".join(str(item) for item in date_range[:2])
        heading = (
            "关联主题脉络"
            if str(topic_card.get("_match_kind") or "").endswith("related")
            else "长期主题脉络"
        )
        lines.extend([
            f"{heading}｜{topic_card.get('topic', '')}｜{range_text}",
            str(topic_card["summary"]),
            "",
        ])
    lines.append(f"检索到 {len(hits)} 条相关日记（仅作参考）：")
    for i, h in enumerate(hits, 1):
        matched = "、".join(h.get("matched") or [])
        suffix = f"（匹配：{matched}）" if matched else ""
        lines.append(f"{i}. [{h['date']}] {h['snippet']}{suffix}")
    lines.append("[/Active Memory]")
    return "\n".join(lines)


# ── 工具 ──────────────────────────────────────────────


def _append_reference(content: Any, reference: str) -> str | list[dict[str, Any]]:
    """将参考数据追加到 user content 尾部。"""
    if isinstance(content, list):
        return [*content, {"type": "text", "text": reference}]
    text = content if isinstance(content, str) else ""
    return f"{text}\n\n{reference}" if text else reference


def _extract_text(content: Any) -> str:
    """从消息 content 提取纯文本，过滤系统注入内容。"""
    if isinstance(content, str):
        text = content.strip()
    elif isinstance(content, list):
        parts = [p.get("text", "") for p in content if isinstance(p, dict)]
        text = " ".join(parts).strip()
    else:
        return ""
    # 过滤 Runtime Context 等系统注入的元数据
    idx = text.find("[Runtime Context")
    if idx != -1:
        text = text[:idx].strip()
    # 跳过定时任务消息
    if text.startswith("## Recent Conversation"):
        return ""
    if text.startswith("The scheduled time has arrived"):
        return ""
    return text


def _log(
    path: Path | None,
    entry: dict[str, Any],
    total_ms: int,
    search_ms: int,
) -> None:
    """追加一条 jsonl 日志。"""
    if path is None:
        return
    entry["total_ms"] = total_ms
    entry["search_ms"] = search_ms
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with suppress(Exception):
        path.parent.mkdir(parents=True, exist_ok=True)
    with suppress(Exception):
        _rotate_log_if_needed(path, len(line.encode("utf-8")))
    with suppress(Exception):
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)


def _rotate_log_if_needed(path: Path, incoming_bytes: int) -> None:
    """当前日志超过阈值时按切分时间移入 archive。"""
    if not path.exists():
        return
    current_bytes = path.stat().st_size
    if current_bytes == 0 or current_bytes + incoming_bytes <= ACTIVE_MEMORY_LOG_MAX_BYTES:
        return

    archive_dir = path.parent / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(SHANGHAI).strftime("%Y%m%d-%H%M%S-%f")
    archive_path = archive_dir / f"{path.stem}-{timestamp}{path.suffix}"
    collision = 1
    while archive_path.exists():
        archive_path = archive_dir / f"{path.stem}-{timestamp}-{collision}{path.suffix}"
        collision += 1
    path.replace(archive_path)
