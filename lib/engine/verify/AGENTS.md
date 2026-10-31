# lib/engine/verify/

`forge verify` and the verify record: the gate's steps, and the one reader of `job.verifyRuns`.

- Import order, kept acyclic: `record.ts` ← everything (it imports nothing in this folder); `steps.ts` ← `gate.ts`, and `steps.ts` never imports `gate.ts`; `e2e.ts` ← `gate.ts`; `failing.ts` ← `gate.ts`, and `failing.ts` imports only a type from `steps.ts`; `cache.ts` imports nothing in this folder, since `lib/engine/workspace/run.ts` imports it.
- **The check cache is read as hostile.** `.forge/runtime/checks/<id>.jsonl` is out of reach of Claude Code's file tools (`Edit(.forge/runtime/**)`), but code a configured command runs can append to it, unattended too, so `cache.ts` reads it without following links, size-capped and field by field (`at` only in the shape `now()` writes), and appends through `openAppend`. Only configured root commands are ever reused: the gates verify adds itself always run. Only sandboxing configured commands closes a forged line ([Check cache](../../../docs/CONFIG.md#check-cache)).
- **Only `record.ts` reads `job.verifyRuns`.** Every other module asks it: this round's last run is the job's latest verify, and a HEAD is verified only when that run passed on it and on every member HEAD (`headVerified`). job.json is agent-writable, so the record treats every field as hostile.
- `verify` and `verifyMember` run configured commands, the e2e step included, only through the `CommandRunner` they are given: `COMMAND_RUNNER` (`runCommand` and `runCommandAsync`) outside tests, a stub in them.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `cache.ts` | The check cache: passes of configured commands on a clean committed tree, which `forge verify` reuses instead of running the command again. |
| `components.ts` | The recompute of a job's components from its committed diff, run by `forge verify` before anything reads a component, so the commands verify picks follow what the build changed rather than the spec's estimate. |
| `e2e.ts` | Whether `forge verify` should run the e2e command: unit tests alone don't prove UI work, but a browser suite is too slow to run on every backend-only change. |
| `failing.ts` | The verify report's `Failing:` list: each failing `node --test` test by file, line, name and message, parsed from a failed step's log, so a rework builder starts from names instead of a tail. |
| `gate.ts` | `forge verify`, the gate between build and review, and verifiedHead, which asks the verify record whether the worktree's HEAD is verified. |
| `record.ts` | The verify record: the one reader of `job.verifyRuns`, answering this round's run, whether a HEAD is verified, and the next attempt. |
| `steps.ts` | Verify's steps beside the root's run: the notes step, a member repo's checks, the lockfile snapshot and restore around a group, and the report's step sections. |
<!-- forge:map:end -->
