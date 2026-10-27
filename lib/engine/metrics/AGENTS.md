# lib/engine/metrics/

Stats, token usage, spend and budgets.

- **Claude Code transcripts** (`~/.claude/projects/*/<session>/subagents/agent-<id>.jsonl`) log each content block as its own line sharing one `message.id`. Their `usage.output_tokens` is the stream's opening snapshot, not the final count, which is why `usage.ts` dedupes by message id, counts tools by block id, and estimates output from content.
- Design: [Policies](../../../docs/architecture/policies.md), [Job model](../../../docs/architecture/job-model.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `budget.ts` | Per-job budgets. |
| `composition.ts` | What filled an agent run's context, estimated from its Claude Code transcript: the start prefix split into the Forge prompt and the harness, then the messages by kind and tool, scaled to the API's exact input totals. |
| `daily.ts` | Per-UTC-day totals over a window ending today: the jobs shipped (non-eval, state done, on the day of finishedAt, live or archived) and the spend ledger's cost (reported and metered), for the Overview's graphs (GET /api/projects/stats). |
| `meter.ts` | The supervisor's meter: what each daemon session spent, per turn, from claude's own cost report on its result line. |
| `repo-budget.ts` | The repo budget: caps on what the whole repo spends per UTC day and month (config `budget:`), separate from per-job budgets. |
| `runs.ts` | A role's agent runs as the job detail serves them: the runs that ended before runHistory existed, rebuilt from agent-end events, then the recorded ones (recordRun in lib/core/job/schema.ts), their total, and the agents without either for /api/state. |
| `spend.ts` | The repo spend ledger, one ledger from two sources: every job's agent-end usage (reported), re-priced with today's table, and every daemon session's supervisor-metered spend (lib/engine/metrics/meter.ts), each bucketed by UTC day, role and model, across live jobs, archive records and the inbox and office sessions. |
| `stats.ts` | Forge metrics. |
| `types.ts` | The spend ledger's bucket and `forge stats --by prompt`'s shapes, type-only. |
| `usage.ts` | Token usage read from Claude Code transcripts (a subagent's, or a role run's own session): deduped by message id, tools counted by block id, output estimated from content because the logged count is the stream's opening snapshot. |
<!-- forge:map:end -->
