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

At startup, nanobot scans the configured diary paths and builds a SQLite FTS5 full-text index. Only changed files (by `mtime`) are re-indexed on subsequent startups, so the process stays fast over time.

Two things happen automatically when historical journals are enabled:

1. **Context preloading**: the most recent N days of diary summaries are injected into the system prompt under `# Historical Journals`, giving the agent immediate background on recent life events without requiring an explicit search.
2. **`memory_search` tool**: the agent can actively query the index by keyword, returning matched entries with their date, summary, and a relevant text snippet.

The diary files are **read-only**. `read_file` and `grep` can access them; `edit_file` and `write_file` cannot, even when `restrictToWorkspace` is enabled.

### Indexing and Chinese text

Diary content is cleaned before indexing: weather API JSON blocks, image embeds (`![[...]]`), nested callout lines (`>>`), callout markers, HTML tags, and Markdown table separators are stripped. The Obsidian frontmatter fields `概要` (summary), `心情` (mood), and `tags` are extracted separately and stored as dedicated columns.

For Chinese text, nanobot uses character-level segmentation by default: each CJK character becomes its own token, while ASCII words are kept whole. FTS5 phrase queries ensure that multi-character Chinese words still match precisely. This requires no external dependencies and handles common two-character words reliably.

### Configuration

Historical journals are configured under `agents.defaults.historicalMemory`:

```json
{
  "agents": {
    "defaults": {
      "historicalMemory": {
        "enabled": true,
        "paths": ["/Users/you/notes/日记"],
        "glob": "**/*.md",
        "datePattern": "(\\d{4}-\\d{2}-\\d{2})",
        "preloadRecentDays": 2,
        "searchTopK": 5,
        "indexPath": null,
        "tokenizer": "char"
      }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `enabled` | Whether to activate historical memory. Defaults to `false` |
| `paths` | List of absolute paths to scan for diary files |
| `glob` | Glob pattern for diary files within each path. Defaults to `**/*.md` |
| `datePattern` | Regex to extract `YYYY-MM-DD` from the filename or path. Falls back to file `mtime` |
| `preloadRecentDays` | How many recent days to inject into the system prompt. Defaults to `2` |
| `searchTopK` | Maximum number of results returned by `memory_search`. Defaults to `5` |
| `indexPath` | Path to the SQLite index file. Defaults to `workspace/memory/historical.db` |
| `tokenizer` | Segmentation mode: `char` (default, zero-dependency). `trigram`, `jieba`, `simple` are reserved for future use |

The index is built in the background at startup. If a search is requested before indexing completes, `memory_search` returns a polite notice rather than blocking.

## In Practice

What this means in daily use is simple:

- conversations can stay fast without carrying infinite context
- durable facts can become clearer over time instead of noisier
- the user can inspect and restore memory when needed

Memory should not feel like a dump. It should feel like continuity.

That is what this design is trying to protect.

## See also

- [Dream vs Hermes skills (中文)](./dream-vs-hermes-skills-zh.md) — how Dream discovers and creates workspace skills, compared to Hermes Agent's self-learning loop
