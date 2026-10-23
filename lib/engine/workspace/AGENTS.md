# lib/engine/workspace/

Job worktrees and what runs in them: checkouts, focus, the editor, regeneration and configured job commands.

- `job-command.ts` builds the environment, placeholders and shell (sync `shell` and async `shellAsync`) of a configured command Forge runs for a job, apart from `run.ts` and `worktree.ts` so callers can build one without loading them.
- `forge verify` lives in `lib/engine/verify/`, which imports `run.ts`; nothing here imports it. `worktree.ts` imports `run.ts` for the checkout undo, `dev-server.ts` imports `dev-probe.ts`, and `dev-probe.ts` imports none of the others.
- **Worktrees live outside the repo** on purpose: a nested worktree inside a Cargo workspace breaks Cargo, and bundlers and watchers pick up the copies. Don't "simplify" this to an in-repo `.worktrees/`.
- Design: [Concurrency](../../../docs/architecture/concurrency.md), [Dashboard security](../../../docs/architecture/dashboard-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `checkout.ts` | Checkout steps: what `forge focus` does to fixed paths and with configured commands so tools that read one place (a DAW's plug-in folder) follow the focused job. |
| `dev-probe.ts` | The dev server's process proof: whether a recorded pid is the dev server Forge started for this job, read through a probe that tests replace. |
| `dev-server.ts` | The background dev server: start a long-running command detached, prove a recorded pid is the one Forge started before the dashboard stops it, and probe whether its port answers. |
| `editor.ts` | The dashboard's Open in editor: which command runs, and the only directory it may be given. |
| `focus-actions.ts` | The one write path for focus, shared by `forge focus` and POST /api/focus (as core/config/set.ts is for config): validation, the locked write and the events. |
| `job-command.ts` | The environment, placeholders and shell of a configured command Forge runs for a job, with the shell's async twin verify runs steps through. |
| `regenerate.ts` | Committed build output (`worktrees.generated`) that conflicts during `forge integrate`: Forge takes the base side, runs `worktrees.generatedBy` and stages the result, instead of handing generated files to the integrator. |
| `run.ts` | Configured commands: fill a command's template and run it in the job's or a member's worktree, synchronously for `forge run` and without blocking for verify, logging each run alike. |
| `seed.ts` | Worktree seeds (`worktrees.seed`): a private, Forge-owned copy of a fresh base worktree's untracked dependency paths and caches, which new job worktrees clone copy-on-write while their key files match. |
| `worktree.ts` | Job worktrees: create and remove the root's and members' worktrees, outside the repo under `worktrees.root`. |
<!-- forge:map:end -->
