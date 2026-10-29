# lib/engine/workspace/

Job worktrees and what runs in them: checkouts, focus, the editor, regeneration and configured job commands.

- `job-command.ts` builds the environment, placeholders and shell (sync `shell` and async `shellAsync`) of a configured command Forge runs for a job, apart from `run.ts` and `worktree.ts` so callers can build one without loading them. Its env builds on `commandEnv` (the allowlist plus `commandEnv.inherit`, the same in and out of the daemon) and its argv comes from `commandShell` with `login: loginShell(config)`, all in `lib/engine/guard/command-env.ts`: a new spawn site of a configured command uses those, never `process.env` or `posixShell()` directly, and passes the login setting through `shell`/`shellAsync`'s `{ login }`.
- `forge verify` lives in `lib/engine/verify/`, which imports `run.ts`; nothing here imports it. `worktree.ts` imports `run.ts` for the checkout undo and `editor.ts` for `containedWorktree`, `dev-server.ts` imports `dev-probe.ts`, and `dev-probe.ts` imports none of the others.
- `related-tests.ts` imports `run.ts` to run the selection and `../pipeline/scope.ts` for `resolveBase`, so `--changed` compares against the same merge-base as `forge job scope` and verify; nothing here imports it.
- `context-session.ts` holds a role run's context session logic (eligibility, key, inputs, records, the key's lock and the fork baseline) and imports only `#core/` and types; `forge job agent run` (lib/cli/commands/job/agent-run.ts) launches the child through the callback `resolveContext` takes, so env, logs, redaction and interrupts stay there. Its inputs are agent-written job files: read only through `readRegular` with the parent realpath check, never followed.
- `seed.ts` imports only `#core/`; `worktree.ts` imports it. A seed holds code later runs execute, so read its trust argument before changing where it lives, what may write it or how it is cloned.
- **Worktrees live outside the repo** on purpose: a nested worktree inside a Cargo workspace breaks Cargo, and bundlers and watchers pick up the copies. Don't "simplify" this to an in-repo `.worktrees/`.
- Design: [Concurrency](../../../docs/architecture/concurrency.md), [Dashboard security](../../../docs/architecture/dashboard-security.md), [Start-up cache › Worktree seeds](../../../docs/architecture/startup-cache.md#worktree-seeds).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `checkout.ts` | Checkout steps: what `forge focus` does to fixed paths and with configured commands so tools that read one place (a DAW's plug-in folder) follow the focused job. |
| `context-session.ts` | Context sessions: one headless child per round and key reads the round's shared inputs once, so each review lens and rework build of that round forks it with them already in context. |
| `dev-probe.ts` | The dev server's process proof: whether a recorded pid is the dev server Forge started for this job, read through a probe that tests replace. |
| `dev-server.ts` | The background dev server: start a long-running command detached, prove a recorded pid is the one Forge started before the dashboard stops it, and probe whether its port answers. |
| `editor.ts` | The dashboard's Open in editor: which command runs, and the only directory it may be given. |
| `focus-actions.ts` | The one write path for focus, shared by `forge focus` and POST /api/focus (as core/config/set.ts is for config): validation, the locked write and the events. |
| `job-command.ts` | The environment, placeholders and shell of a configured command Forge runs for a job, with the shell's async twin verify runs steps through: the env builds on commandEnv and the argv comes from commandShell (lib/engine/guard/command-env.ts). |
| `regenerate.ts` | Committed build output (`worktrees.generated`) that conflicts during `forge integrate`: Forge takes the base side, runs `worktrees.generatedBy` and stages the result, instead of handing generated files to the integrator. |
| `related-tests.ts` | Related tests: the test files a job's changes since its base need, which `forge run <job> <command> --changed` passes at the command's `{args}` instead of running the whole suite. |
| `run.ts` | Configured commands: fill a command's template and run it in the job's or a member's worktree, synchronously for `forge run` and without blocking for verify, logging each run alike. |
| `seed.ts` | Worktree seeds (`worktrees.seed`): a private, Forge-owned copy of a fresh base worktree's untracked dependency paths and caches, which new job worktrees clone copy-on-write while their key files match. |
| `worktree.ts` | Job worktrees: create and remove the root's and members' worktrees, outside the repo under `worktrees.root`. |
<!-- forge:map:end -->
