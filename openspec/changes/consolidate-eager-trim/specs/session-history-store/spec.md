## ADDED Requirements

### Requirement: Consolidation triggers immediate physical trim
When consolidation advances `last_consolidated` (in `maybe_consolidate_by_tokens` or `compact_idle_session`), the system SHALL immediately remove `session.messages[:end_idx]` from the in-memory session and persist the shortened session, resetting `last_consolidated` to 0.

#### Scenario: Eager trim after token-budget consolidation
- **WHEN** `maybe_consolidate_by_tokens` successfully archives a chunk ending at `end_idx`
- **THEN** `session.messages` SHALL equal `session.messages[end_idx:]` before the next save
- **AND** `session.last_consolidated` SHALL be 0

#### Scenario: Eager trim after idle compact
- **WHEN** `compact_idle_session` archives the consolidated prefix
- **THEN** the consolidated prefix SHALL be removed from `session.messages` immediately
- **AND** `session.last_consolidated` SHALL be 0

#### Scenario: No trim when consolidation LLM fails
- **WHEN** the consolidation LLM call fails and `raw_archive` fallback is used
- **THEN** the messages SHALL still be physically trimmed (raw archive is acceptable as evidence)
- **AND** `session.last_consolidated` SHALL be reset to 0

### Requirement: Trimmed messages written to SQLite
The system SHALL write each trimmed message as an individual row to `sessions/history.db` (SQLite) before physically removing it from the session.

#### Scenario: Insert rows at consolidation time
- **WHEN** a chunk of messages is trimmed after consolidation
- **THEN** each message in the chunk SHALL produce one row in `session_messages` table
- **AND** the row SHALL contain: `session_key`, `trimmed_at` (ISO8601 UTC), `reason` (`consolidation` or `idle_compact`), `role`, `content_text`, `raw_json`

#### Scenario: SQLite write failure does not block conversation
- **WHEN** writing to SQLite raises an exception
- **THEN** the exception SHALL be logged as a warning
- **AND** the physical trim SHALL still proceed normally

#### Scenario: content_text extraction for text messages
- **WHEN** inserting a `user` or `assistant` message whose content is a string
- **THEN** `content_text` SHALL equal that string

#### Scenario: content_text extraction for complex content
- **WHEN** inserting a message with a content list (text blocks, tool_use, Anthropic-style tool_result)
- **THEN** `content_text` SHALL be the concatenation of all extractable text: text blocks, tool_use name+input, tool_result content
- **AND** if no extractable text exists, `content_text` SHALL fall back to the first 500 characters of `raw_json`

#### Scenario: content_text extraction for OpenAI-style tool role
- **WHEN** inserting a message with `role="tool"` and `content` as a string
- **THEN** `content_text` SHALL equal that string directly

### Requirement: SQLite schema initialized on first use
The system SHALL create the `session_messages` table and indexes if they do not exist when `SessionHistoryStore` is instantiated.

#### Scenario: Fresh workspace
- **WHEN** `SessionHistoryStore` is constructed with a `sessions_dir` that has no `history.db`
- **THEN** `sessions/history.db` SHALL be created with `session_messages` table and indexes on `session_key` and `trimmed_at`

#### Scenario: Existing database
- **WHEN** `SessionHistoryStore` is constructed and `history.db` already exists
- **THEN** `CREATE TABLE IF NOT EXISTS` SHALL be used; no error SHALL be raised and existing data SHALL be preserved

### Requirement: Concurrent write safety
The store SHALL be safe for concurrent writes from multiple coroutines in the same process.

#### Scenario: Concurrent consolidation from multiple channels
- **WHEN** two sessions consolidate simultaneously
- **THEN** both sets of rows SHALL be inserted without data corruption or errors
