# lib/integrations/claude/

Claude Code's files and prices: session transcripts and the model price table.

- `pricing.json` holds the model prices: take them from Anthropic's current pricing, never from memory, and bump `asOf`. `pricing()` and `/api/about` read it through `PLUGIN_ROOT`.
- Transcript paths come from job state only, which an agent or a checkout can write, so each id is checked before it becomes a path segment.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `pricing.ts` | Model prices (lib/integrations/claude/pricing.json merged with config.usage.pricing) and the cost estimate built on them. |
| `transcripts.ts` | Claude Code transcripts of this repo's sessions and their agents, located from job state only. |
<!-- forge:map:end -->
