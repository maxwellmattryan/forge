# lib/engine/workspace/

Job worktrees and what runs in them: checkouts, focus, the editor, regeneration and configured job commands.

- `job-command.ts` builds the environment, placeholders and shell of a configured command Forge runs for a job, apart from `worktree.ts` so callers can build one without loading it.
- **Worktrees live outside the repo** on purpose: a nested worktree inside a Cargo workspace breaks Cargo, and bundlers and watchers pick up the copies. Don't "simplify" this to an in-repo `.worktrees/`.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `checkout.ts` | Checkout steps: what `forge focus` does to fixed paths and with configured commands so tools that read one place (a DAW's plug-in folder) follow the focused job. |
| `editor.ts` | The dashboard's Open in editor: which command runs, and the only directory it may be given. |
| `focus-actions.ts` | The one write path for focus, shared by `forge focus` and POST /api/focus (as core/config/set.ts is for config): validation, the locked write and the events. |
| `job-command.ts` | The environment, placeholders and shell of a configured command Forge runs for a job. |
| `regenerate.ts` | Committed build output (`worktrees.generated`) that conflicts during `forge integrate`: Forge takes the base side, runs `worktrees.generatedBy` and stages the result, instead of handing generated files to the integrator. |
| `worktree.ts` | Job worktrees and what runs in them: create and remove worktrees, run configured commands, `forge verify`, and the background dev server. |
<!-- forge:map:end -->
