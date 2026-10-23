# lib/engine/verify/

`forge verify` and the verify record: the gate's steps, and the one reader of `job.verifyRuns`.

- Import order, kept acyclic: `record.ts` ← everything (it imports nothing in this folder); `steps.ts` ← `gate.ts`, and `steps.ts` never imports `gate.ts`; `e2e.ts` ← `gate.ts`.
- **Only `record.ts` reads `job.verifyRuns`.** Every other module asks it: this round's last run is the job's latest verify, and a HEAD is verified only when that run passed on it and on every member HEAD (`headVerified`). job.json is agent-writable, so the record treats every field as hostile.
- `verify` and `verifyMember` run configured commands, the e2e step included, only through the `CommandRunner` they are given: `COMMAND_RUNNER` (`runCommand` and `runCommandAsync`) outside tests, a stub in them.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `e2e.ts` | Whether `forge verify` should run the e2e command: unit tests alone don't prove UI work, but a browser suite is too slow to run on every backend-only change. |
| `gate.ts` | `forge verify`, the gate between build and review, and verifiedHead, which asks the verify record whether the worktree's HEAD is verified. |
| `record.ts` | The verify record: the one reader of `job.verifyRuns`, answering this round's run, whether a HEAD is verified, and the next attempt. |
| `steps.ts` | Verify's steps beside the root's run: the notes step, a member repo's checks, the lockfile snapshot and restore around a group, and the report's step sections. |
<!-- forge:map:end -->
