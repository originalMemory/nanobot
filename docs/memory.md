# Memory in nanobot

nanobot's memory is built on a simple belief: memory should feel alive, but it should not feel chaotic.

Good memory is not a pile of notes. It is a quiet system of attention. It notices what is worth keeping, lets go of what no longer needs the spotlight, and turns lived experience into something calm, durable, and useful.

That is the shape of memory in nanobot.

## The Design

nanobot does not treat memory as one giant file.

It separates memory into layers, because different kinds of remembering deserve different tools:

- `session.messages` holds the living short-term conversation.
- `memory/history.jsonl` is the running archive of compressed past turns.
- `SOUL.md`, `USER.md`, and `memory/MEMORY.md` are the durable knowledge files.
- `GitStore` records how those durable files change over time.

This keeps the system light in the moment, but reflective over time.

## The Flow

Memory moves through nanobot in two stages.

### Stage 1: Consolidator

When a conversation grows large enough to pressure the context window, nanobot does not try to carry every old message forever.

Instead, the `Consolidator` summarizes the oldest safe slice of the conversation and appends that summary to `memory/history.jsonl`.

This file is:

- append-only
- cursor-based
- optimized for machine consumption first, human inspection second

Each line is a JSON object:

```json
{"cursor": 42, "timestamp": "2026-04-03 00:02", "content": "- User prefers dark mode\n- Decided to use PostgreSQL"}
```

It is not the final memory. It is the material from which final memory is shaped.

When a chunk is consolidated, nanobot also **eager-trims** the corresponding prefix from `session.messages` and writes each removed message into `sessions/history.db` (SQLite). This keeps live sessions small while preserving searchable raw turns.

The flow is: `archive()` (LLM summary → `history.jsonl`) → physical trim → SQLite insert → `last_consolidated = 0`. Consolidation, deletion, and raw-message archival happen in one step instead of waiting for a later file-cap trim.

The agent can retrieve trimmed turns with the **`search_session_history`** tool:

- `query` (required): keyword search over message text
- `session_key` (optional): limit to one session, e.g. `cli:default`
- `since` / `until` (optional): ISO date or datetime filter
- `limit` (optional): max results (default 20, max 100)

`idle_compact` (AutoCompact on idle sessions) uses the same SQLite path with reason `idle_compact`.

**What is not in `history.db`:** `enforce_file_cap` — the last-resort guard when a session exceeds `FILE_MAX_MESSAGES` — still raw-archives dropped turns into `memory/history.jsonl` via `on_archive`, but does **not** write full message JSON to SQLite. Those turns are summarized breadcrumbs only, not searchable through `search_session_history`.

### Stage 2: Dream

`Dream` is the slower, more thoughtful layer. It runs on a cron schedule by default and can also be triggered manually.

Dream reads:

- new entries from `memory/history.jsonl`
- the current `SOUL.md`
- the current `USER.md`
- the current `memory/MEMORY.md`

Then it edits the long-term files surgically in a single pass — not by rewriting everything, but by making the smallest honest change that keeps memory coherent.

This is why nanobot's memory is not just archival. It is interpretive.

## The Files

```text
workspace/
├── SOUL.md              # The bot's long-term voice and communication style
├── USER.md              # Stable knowledge about the user
├── sessions/
│   └── history.db       # SQLite archive of trimmed session messages (searchable)
└── memory/
    ├── MEMORY.md        # Project facts, decisions, and durable context
    ├── history.jsonl    # Append-only history summaries
    ├── .cursor          # Consolidator write cursor
    ├── .dream_cursor    # Dream consumption cursor
    └── .git/            # Version history for long-term memory files
```

These files play different roles:

- `SOUL.md` remembers how nanobot should sound.
- `USER.md` remembers who the user is and what they prefer.
- `MEMORY.md` remembers what remains true about the work itself.
- `history.jsonl` remembers what happened on the way there.

## Why `history.jsonl`

The old `HISTORY.md` format was pleasant for casual reading, but it was too fragile as an operational substrate.

`history.jsonl` gives nanobot:

- stable incremental cursors
- safer machine parsing
- easier batching
- cleaner migration and compaction
- a better boundary between raw history and curated knowledge

You can still search it with familiar tools:

```bash
# grep
grep -i "keyword" memory/history.jsonl

# jq
cat memory/history.jsonl | jq -r 'select(.content | test("keyword"; "i")) | .content' | tail -20

# Python
python -c "import json; [print(json.loads(l).get('content','')) for l in open('memory/history.jsonl','r',encoding='utf-8') if l.strip() and 'keyword' in l.lower()][-20:]"
```

The difference is philosophical as much as technical:

- `history.jsonl` is for structure
- `SOUL.md`, `USER.md`, and `MEMORY.md` are for meaning

## Commands

Memory is not hidden behind the curtain. Users can inspect and guide it.

| Command | What it does |
|---------|--------------|
| `/dream` | Run Dream immediately |
| `/dream-log` | Show the latest Dream memory change |
| `/dream-log <sha>` | Show a specific Dream change |
| `/dream-restore` | List recent Dream memory versions |
| `/dream-restore <sha>` | Restore memory to the state before a specific change |

These commands exist for a reason: automatic memory is powerful, but users should always retain the right to inspect, understand, and restore it.

## Versioned Memory

After Dream changes long-term memory files, nanobot can record that change with `GitStore`.

This gives memory a history of its own:

- you can inspect what changed
- you can compare versions
- you can restore a previous state

That turns memory from a silent mutation into an auditable process.

## Configuration

Dream is configured under `agents.defaults.dream`:

```json
{
  "agents": {
    "defaults": {
      "dream": {
        "intervalH": 2,
        "modelOverride": null,
        "maxBatchSize": 20,
        "maxIterations": 10
      }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `intervalH` | How often Dream runs, in hours |
| `cron` | Cron expression override (takes precedence over `intervalH`) |
| `modelOverride` | Optional Dream-specific model override *(pending implementation)* |
| `maxBatchSize` | *(Deprecated — not used)* |
| `maxIterations` | *(Deprecated — not used)* |

In practical terms:

- `intervalH` is the normal way to configure Dream frequency. Internally it runs as an `every` schedule.
- `cron` overrides `intervalH` when set, allowing precise cron expressions (e.g. `0 */4 * * *`).
- `modelOverride` is reserved for a future release. Currently Dream uses the same model as the main agent.
- `maxBatchSize` and `maxIterations` are preserved for config compatibility but no longer affect behavior.

## Historical Journals

nanobot can connect to an external library of historical diary files — thousands of daily Markdown notes written outside of any nanobot workspace — and make them searchable and contextually available during conversation.

This is useful when a user has years of personal writing that captures decisions, moods, relationships, and experiences that a fresh workspace cannot know about.

### How it works

At startup, nanobot scans the configured note root and builds a SQLite index. Only changed files (by `mtime`) are re-indexed on subsequent startups, so the process stays fast over time.

Two things happen automatically when historical journals are enabled:

1. **Context preloading**: the most recent N days of diary summaries are injected into the system prompt under `# Historical Journals`, giving the agent immediate background on recent life events without requiring an explicit search.
2. **`memory_search` tool**: the agent can actively query both archived chat transcripts and the diary index in one parallel call. Results are grouped by source — `原始对话` for raw conversation turns, `日记笔记` for user-perspective journal/notes (date, summary, snippet).

The diary files are **read-only**. `read_file` and `grep` can access them; `edit_file` and `write_file` cannot, even when `restrictToWorkspace` is enabled.

### Indexing and search

Diary content is cleaned before indexing: weather API JSON blocks, image embeds (`![[...]]`), nested callout lines (`>>`), callout markers, HTML tags, and Markdown table separators are stripped. The Obsidian frontmatter fields `概要` (summary), `心情` (mood), and `tags` are extracted separately and stored as dedicated columns.

Search uses SQLite `LIKE` on the stored plain text (no FTS5 dependency). Multi-word queries try **AND** first (all keywords must appear), then fall back to **OR** if results are insufficient. Results are ordered by date descending within each group. Chinese and English keywords are matched as substrings.

If the index schema changes, delete `workspace/memory/historical.db` and let nanobot rebuild it on the next startup.

### Configuration

Historical journals are configured under `agents.defaults.historicalMemory`:

```json
{
  "agents": {
    "defaults": {
      "historicalMemory": {
        "enabled": true,
        "root": "/Users/you/notes",
        "diaryPath": "日记",
        "glob": "**/*.md",
        "datePattern": "(\\d{4}-\\d{2}-\\d{2})",
        "preloadRecentDays": 2,
        "searchTopK": 10,
        "refreshIntervalM": 1440
      }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `enabled` | Whether to activate historical memory. Defaults to `false` |
| `root` | Absolute path to the note library root (e.g. `~/note`) |
| `diaryPath` | Subdirectory under `root` treated as diary files (date from filename, `概要`/`心情` parsed). Other files are indexed as notes (date from frontmatter `created`/`date`). Empty means all files are notes |
| `glob` | Glob pattern for files under `root`. Defaults to `**/*.md` |
| `datePattern` | Regex to extract `YYYY-MM-DD` from diary filenames or paths. Falls back to file `mtime` |
| `preloadRecentDays` | How many recent days of diary summaries to inject into the system prompt. Defaults to `2` |
| `searchTopK` | Maximum diary hits returned per `memory_search` call (diary section cap is 20). Defaults to `10` |
| `refreshIntervalM` | Background re-index interval in minutes. `0` means build once at startup only |

The SQLite index is always stored at `workspace/memory/historical.db`.

The index is built in the background at startup. If a search is requested before indexing completes, the `日记笔记` section of `memory_search` returns a polite notice while `原始对话` results are still returned.

## In Practice

What this means in daily use is simple:

- conversations can stay fast without carrying infinite context
- durable facts can become clearer over time instead of noisier
- the user can inspect and restore memory when needed

Memory should not feel like a dump. It should feel like continuity.

That is what this design is trying to protect.

## See also

- [Dream vs Hermes skills (中文)](./dream-vs-hermes-skills-zh.md) — how Dream discovers and creates workspace skills, compared to Hermes Agent's self-learning loop
