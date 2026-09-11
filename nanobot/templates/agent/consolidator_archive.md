Extract key facts from this conversation. For each fact, annotate its memory attributes.

Use SNIP for stable facts:
- Signal: would the user need to repeat this if forgotten?
- Novel: not just a restatement of another fact in this same conversation chunk
- Important: prevents rework or captures preferences / rules
- Persistent: still relevant after 2 weeks

Output one fact per line in this format:
- [mark] fact content

Marks (choose the best match):
- [permanent] Core preferences, personal traits, habits — never becomes stale
- [durable] Technical discoveries, project knowledge, config details — valid for months
- [ephemeral] Active task state, temporary decisions — may change in weeks
- [correction] Correction to a previous memory — state what changed
- [skip] Does not meet SNIP criteria, is conversational filler, is code/source facts derivable from the repo, or is only useful as an audit breadcrumb

Also retain important ongoing events as [ephemeral], even if relevant for less than two weeks:
confirmed appointments, unresolved concerns, meaningful progress and changes the user would otherwise have to explain again. Ordinary daily filler and tool execution logs still do not deserve memory.

Priority: user corrections, preferences and important unresolved events > decisions > reusable solutions > environment facts. Long tool output must not crowd out what the user cares about.

For retained events, include the absolute event date, actor, confirmed state, and any unresolved next step. Resolve relative dates against the original message timestamp, never the archive execution time; if the date cannot be established, say it is unknown. A plan passing its date does not prove completion.

Distinguish a factual correction from a real change over time. Preserve meaningful transitions as `过去状态 → 后来状态（日期），用户说明的原因` rather than erasing the earlier experience. Preserve uncertainty: an assistant's psychological interpretation or repeated paraphrase is not independent user confirmation.

For every retained fact involving an action, judgment, decision, recommendation, or correction, preserve the actor and status explicitly:
- `用户确认／决定／亲自完成：…`
- `焰执行／建议／判断／修复：…`
- `系统／cron：仅提醒／自动执行／未执行：…`
- Do not turn the assistant's suggestion, inference, query, or action into a user decision, opinion, or completed action.

Retain operational corrections only when forgetting them would repeat a user-visible failure. State `旧规则 → 正确规则 → 适用边界`, including external identifier mappings, cron responsibility boundaries, path migrations, and whether media must enter the diary.

Do not mark something [skip] merely because it might already exist in long-term memory; Dream handles cross-file deduplication later.

Output concise bullet points only. No preamble, no commentary.
If nothing noteworthy happened, output: (nothing)
