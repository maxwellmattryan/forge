# lib/engine/metrics/

Stats, token usage, spend and budgets.

- **Claude Code transcripts** (`~/.claude/projects/*/<session>/subagents/agent-<id>.jsonl`) log each content block as its own line sharing one `message.id`. Their `usage.output_tokens` is the stream's opening snapshot, not the final count, which is why `usage.ts` dedupes by message id, counts tools by block id, and estimates output from content.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `budget.ts` | Per-job budgets. |
| `repo-budget.ts` | The repo budget: caps on what the whole repo spends per UTC day and month (config `budget:`), separate from per-job budgets. |
| `spend.ts` | The repo spend ledger: every job's agent-end usage, re-priced with today's table and bucketed by UTC day, role and model, across live jobs and archive records. |
| `stats.ts` | Forge metrics. |
| `types.ts` | The spend ledger's bucket and `forge stats --by prompt`'s shapes, type-only. |
| `usage.ts` | Token usage read from Claude Code transcripts: deduped by message id, tools counted by block id, output estimated from content because the logged count is the stream's opening snapshot. |
<!-- forge:map:end -->
