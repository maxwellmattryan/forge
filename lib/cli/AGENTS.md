# lib/cli/

The `forge` command: the entry that routes, the command groups and the activity log.

- `bin/forge` turns on the start-up cache, then imports `main.ts`. `main.ts` only routes: no help or usage text of its own, and a new command goes in `commands/<group>.ts`, never here.
- Nothing imports `cli`. It may import `server`, because `forge dash` starts it.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `activity.ts` | `forge dash`'s activity log: one timestamped line per session transition, notable request and job event, printed in the foreground in human mode only (docs/CLI.md "Output mode"). |
| `commands/` | One module per command group, each with its `HELP` table, and the human-mode renderers. |
| `main.ts` | The `forge` CLI: the only writer of Forge state. |
<!-- forge:map:end -->
