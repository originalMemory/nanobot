Create a compact replacement checkpoint for this session.

When `[Archived Context Summary]` appears in the system prompt, update that previous checkpoint to reflect the current conversation state.

## Merge rules

- Use the latest correction or decision as the current version of a fact, and merge duplicates.
- Preserve exact names, identifiers, paths, commands, decisions, results, and unresolved blockers when they are needed to continue the session.
- Retain a fact already present in long-term memory when it is needed for session continuity.

## What to retain

Always retain a compact working-state handoff:
- active objective
- current status
- completed results that constrain later work
- unresolved blockers
- next action
- exact identifiers needed for that action

Mark working-state facts `[ephemeral]`.

For other facts, retain a candidate only when it meets all four SNIP criteria:
- Signal: remembering it saves the user from repeating it
- Novel: it adds a distinct fact to this checkpoint
- Important: losing it would cause rework or discard a preference or rule
- Persistent: it is expected to remain useful for at least two weeks

Assign each retained fact its best current mark:
- `[permanent]` for core preferences, personal traits, and habits that remain relevant indefinitely
- `[durable]` for technical discoveries, project knowledge, and configuration that remains valid for months
- `[ephemeral]` for active task state and temporary decisions that may change within weeks
- `[correction]` for the current fact that supersedes conflicting earlier long-term memory

When space is limited, prioritize user corrections and preferences, then solutions, decisions, events, and environment facts.

## Personal events and attribution

- Also retain important ongoing events as `[ephemeral]`, even when relevant for less than two weeks: confirmed appointments, unresolved concerns, meaningful progress and changes the user would otherwise need to explain again. Ordinary daily filler and tool execution logs do not qualify.
- For retained events, preserve the absolute event date, actor, confirmed state and unresolved next step. Resolve relative dates against the original message timestamp, never the archive execution time; unknown dates remain unknown. Passing a plan's date does not prove completion.
- Distinguish a factual correction from a real change over time. Preserve meaningful transitions as `过去状态 → 后来状态（日期），用户说明的原因`; do not erase a historically true experience just because the current state changed.
- Preserve who confirmed, decided, recommended or completed an action: `用户确认／决定／亲自完成`, `助手执行／建议／判断／修复`, or `系统／cron：仅提醒／自动执行／未执行`. Do not turn the assistant's suggestion, inference, query or action into a user decision, opinion or completed action.
- Retain user-stated reasons and boundaries without inventing motives. Repeated assistant paraphrases or psychological interpretations are not independent user confirmation. Important personal corrections and unresolved concerns must not be crowded out by long technical output.

## Output

Return one concise retained fact per line in this form:
- [mark] fact

Use `(nothing)` when neither the previous checkpoint nor the current conversation contains a qualifying fact or active working state.
