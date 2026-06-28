"""ActiveMemory hook：自动记忆召回。

用户发消息时，用 MBP 上的 Ollama (qwen3:8b) 提取关键词，
grep 搜日记，把结果注入上下文。
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import httpx

from nanobot.agent.hook import AgentHook, AgentHookContext

# ── 配置 ──────────────────────────────────────────────

OLLAMA_URL = "http://192.168.31.75:11434/api/generate"
OLLAMA_MODEL = "qwen3:8b-nothink"
OLLAMA_TIMEOUT = 3.0  # 秒，超时静默跳过

DIARY_DIR = "/home/nanobot/note/日记"
MAX_RESULTS = 5
MAX_KEYWORDS = 5

LOG_PATH = Path("/home/nanobot/.nanobot/workspace/memory/active_memory.jsonl")

SHANGHAI = timezone(timedelta(hours=8))

PROMPT_TEMPLATE = """提取搜索关键词。规则：
1. 只提取专有名称，保留原文标点（如"明末：渊虚之羽"保留冒号）
2. 话题限定词（剧情、到货、bug等）可紧跟实体
3. 日常物品+状态（冰箱裂口、神之手歪刃）视为实体
4. 纯感叹/问候/嗯嗯 → 输出"无"
5. 空格分隔，最多{max_keywords}个

消息：{text}
关键词："""


# ── 核心 ──────────────────────────────────────────────


class ActiveMemoryHook(AgentHook):
    """自动记忆召回 hook。"""

    async def before_iteration(self, context: AgentHookContext) -> None:
        # 只在第一轮处理
        if context.iteration > 0:
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
            _log(log_entry, int((time.monotonic() - t_start) * 1000), 0)
            return
        except Exception:
            log_entry["action"] = "skip_error"
            _log(log_entry, int((time.monotonic() - t_start) * 1000), 0)
            return

        model_ms = int((time.monotonic() - t0) * 1000)
        log_entry["keywords"] = keywords
        log_entry["model_ms"] = model_ms

        if not keywords or keywords == "无":
            log_entry["action"] = "skip_no_keywords"
            _log(log_entry, int((time.monotonic() - t_start) * 1000), 0)
            return

        # Step 2: grep 搜日记
        t1 = time.monotonic()
        hits = await asyncio.to_thread(_grep_diary, keywords)
        search_ms = int((time.monotonic() - t1) * 1000)

        log_entry["search_ms"] = search_ms
        log_entry["files"] = [h["date"] for h in hits]

        if not hits:
            log_entry["action"] = "skip_no_results"
            _log(log_entry, int((time.monotonic() - t_start) * 1000), search_ms)
            return

        # Step 3: 注入 system 消息
        injection = _format_injection(hits)
        context.messages.append({
            "role": "system",
            "content": injection,
        })
        log_entry["action"] = "injected"

        total_ms = int((time.monotonic() - t_start) * 1000)
        _log(log_entry, total_ms, search_ms)

    async def _extract_keywords(self, text: str) -> str:
        """调 MBP Ollama 提取关键词。"""
        prompt = PROMPT_TEMPLATE.format(text=text, max_keywords=MAX_KEYWORDS)
        async with httpx.AsyncClient() as client:
            resp = await client.post(OLLAMA_URL, json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "think": False,
                "options": {"temperature": 0.1, "max_tokens": 40},
                "stream": False,
            })
            resp.raise_for_status()
            data = resp.json()
            return (data.get("response") or "").strip().replace("\n", " ")


# ── 搜索 ──────────────────────────────────────────────


def _grep_diary(keywords: str) -> list[dict[str, str]]:
    """grep AND→OR 搜日记，过滤概要行，返回 [{date, snippet}]。"""
    words = [w for w in keywords.split() if w]
    if not words:
        return []

    # AND：所有词都在文件里
    and_files = _grep_files(words[0])
    for w in words[1:]:
        and_files = {f for f in and_files if _file_contains(f, w)}

    files = and_files

    # 不足 MAX_RESULTS 条 → OR 补充
    if len(files) < MAX_RESULTS:
        or_files: set[str] = set()
        for w in words:
            or_files.update(_grep_files(w))
        # 合并去重，AND 优先
        all_files = list(and_files) + [f for f in or_files if f not in and_files]
    else:
        all_files = list(files)

    # 按日期倒序
    sorted_files = sorted(all_files, reverse=True)[:MAX_RESULTS]

    results = []
    for f in sorted_files:
        basename = Path(f).name
        date = basename[:10]  # YYYY-MM-DD
        snippet = _extract_snippet(f, words)
        if snippet:
            results.append({"date": date, "snippet": snippet, "path": basename})

    return results


def _grep_files(word: str) -> set[str]:
    """grep -rl 搜日记目录。"""
    try:
        r = subprocess.run(
            ["grep", "-rl", "--include=*.md", word, DIARY_DIR],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0 and r.stdout.strip():
            return {f for f in r.stdout.strip().split("\n") if f.strip()}
    except Exception:
        pass
    return set()


def _file_contains(filepath: str, word: str) -> bool:
    """检查文件是否包含某词。"""
    try:
        r = subprocess.run(
            ["grep", "-l", word, filepath],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


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
            l for l in lines
            if not l.strip().startswith("概要:")
            and l.strip() not in ("---", "--", "")
        ]
        return " ".join(cleaned)[:200]
    except Exception:
        return ""


# ── 格式化 ────────────────────────────────────────────


def _format_injection(hits: list[dict[str, str]]) -> str:
    """格式化注入的 system 消息。"""
    lines = [f"[ActiveMemory] 检索到 {len(hits)} 条相关日记（按日期倒序）："]
    for i, h in enumerate(hits, 1):
        lines.append(f"{i}. [{h['date']}] {h['snippet']}")
    return "\n".join(lines)


# ── 工具 ──────────────────────────────────────────────


def _extract_text(content: Any) -> str:
    """从消息 content 提取纯文本。"""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        # multimodal: 取 text 部分
        parts = [p.get("text", "") for p in content if isinstance(p, dict)]
        return " ".join(parts).strip()
    return ""


def _log(
    entry: dict[str, Any],
    total_ms: int,
    search_ms: int,
) -> None:
    """追加一条 jsonl 日志。"""
    entry["total_ms"] = total_ms
    entry["search_ms"] = search_ms
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
