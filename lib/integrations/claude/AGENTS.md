# lib/integrations/claude/

Claude Code's command line, files and prices: the session argv and env, transcripts and the model price table.

- `DENY_TOOLS` and `PROMPT_TOOL` end every argv, and API keys are dropped unless `daemon.auth` is `api-key` (docs/ARCHITECTURE.md "Daemon security").
- `pricing.json` holds the model prices: take them from Anthropic's current pricing, never from memory, and bump `asOf`. `pricing()` and `/api/about` read it through `PLUGIN_ROOT`.
- Transcript paths come from job state only, which an agent or a checkout can write, so each id is checked before it becomes a path segment.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `argv.ts` | Claude Code's command line and environment for a headless session: the permission-mode and effort flags, `daemon.command` to argv, and the child's env. |
| `pricing.ts` | Model prices (lib/integrations/claude/pricing.json merged with config.usage.pricing) and the cost estimate built on them. |
| `transcripts.ts` | Claude Code transcripts of this repo's sessions and their agents, located from job state only. |
<!-- forge:map:end -->
