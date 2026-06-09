## ADDED Requirements

### Requirement: search_session_history tool available to agent
The system SHALL expose a `search_session_history` tool that the agent can call to search the SQLite history store.

#### Scenario: Tool registered in tool registry
- **WHEN** the agent loop initializes tools
- **THEN** `search_session_history` SHALL appear in the available tool list

### Requirement: Keyword search across content_text
The tool SHALL support searching by keyword, matching rows where `content_text` contains the query string (case-insensitive LIKE).

#### Scenario: Keyword match returns relevant rows
- **WHEN** `search_session_history(query="deploy")` is called
- **THEN** the result SHALL contain only rows where `content_text` LIKE `%deploy%`
- **AND** each result SHALL include a `snippet` field showing up to 100 characters around the match

#### Scenario: No matches returns empty list
- **WHEN** `search_session_history(query="zzznomatch")` is called
- **THEN** the result SHALL be an empty list with no error

### Requirement: Filter by session_key
The tool SHALL support an optional `session_key` parameter to restrict results to a single session.

#### Scenario: session_key filter applied
- **WHEN** `search_session_history(query="foo", session_key="telegram:123")` is called
- **THEN** only rows with `session_key = "telegram:123"` SHALL be returned

### Requirement: Filter by time range
The tool SHALL support optional `since` and `until` parameters (ISO date strings) to restrict results by `trimmed_at`.

#### Scenario: since filter applied
- **WHEN** `search_session_history(query="x", since="2026-06-01")` is called
- **THEN** only rows where `trimmed_at >= "2026-06-01"` SHALL be returned

#### Scenario: until filter applied
- **WHEN** `search_session_history(query="x", until="2026-06-07")` is called
- **THEN** only rows where `trimmed_at <= "2026-06-07T23:59:59"` SHALL be returned

### Requirement: Result count limit
The tool SHALL accept an optional `limit` parameter (default 20, maximum 100) capping the number of returned rows.

#### Scenario: Default limit
- **WHEN** `search_session_history(query="test")` is called and 50 rows match
- **THEN** at most 20 rows SHALL be returned

#### Scenario: Custom limit
- **WHEN** `search_session_history(query="test", limit=5)` is called
- **THEN** at most 5 rows SHALL be returned

### Requirement: Result format
Each result item SHALL contain: `session_key`, `trimmed_at`, `role`, `content_text` (truncated to 300 chars), `snippet` (keyword context ±50 chars).

#### Scenario: Result fields present
- **WHEN** `search_session_history` returns results
- **THEN** each item SHALL have keys: `session_key`, `trimmed_at`, `role`, `content_text`, `snippet`
