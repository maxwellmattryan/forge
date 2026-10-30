# lib/office/code/

Work the pool does in code instead of a model session: the `forge` children of `forge dash` (the periodic sync and Office pass, and the code driver's), and the code driver itself.

- Everything that runs git or `gh` (`claim`, `advance`, `agent run`, `agent end`, `job set`, `sync`, `office pass`) runs as a `bin/forge` child through `children.ts`, argv only, never a shell and never in the server's process: git's helpers are synchronous and would stall every session's pipe. In-process the driver only does file I/O through existing helpers (`releaseSession`, `closeIfOpen`, `enqueue`, `loadJob`, `recordPrompt`).
- A job scope's Session is `job-driver.ts` (`createCodeDriver`), which wraps an inner `createSession`: under `daemon.driver: session` it passes every call through; under `code` it takes a job's resume turns itself and hands everything else to the inner session. The driver and the inner session never run at once for a scope.
- `moves.ts` is pure: every decision the driver makes after a child ends is a row of its table, so a new case is a new row there and in `moves.test.ts`, never a branch in the driver.
- A role run's permission prompts reach the dashboard only through `relay.ts`, which checks every IPC field by type and length, answers only the runner that asked, and denies unasked what a session's prompt policy would (`lib/office/session/permissions/control.ts`). Never generalise control.ts for it: that one answers only its own current child.
- A park reason or a lost summary built from a child's output goes to argv only in the joined `--reason=`/`--summary=` form, prefixed `code driver: `, one line of at most 200 characters (`parkReason`).
- Design: [Daemon](../../../docs/architecture/daemon.md), [Daemon runtime](../../../docs/architecture/daemon-runtime.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `children.ts` | The `forge` children of `forge dash`: the periodic ones, `forge sync` and the Office pass (`forge office pass`), outside any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or program the checkout's config names never runs on their fetches; and the code driver's (startForge), each in a job's own scope, as a job session's. |
| `job-driver.ts` | A job scope's Session under `daemon.driver: code`: forge dash drives the job's resume turns itself, running `forge job advance` and one `forge job agent run` per spawn as child processes until a gate or `done`, with no orchestrator session (./turn.ts). |
| `moves.ts` | The code driver's moves: what it does after each `forge job advance` and each `forge job agent run` child ends, as pure functions of the child's exit and output and the turn's counters. |
| `relay.ts` | A code turn's permission prompts: each role run (`forge job agent run --ipc`) sends its child's `can_use_tool` asks to the code driver over IPC, and the relay shows them in the dashboard, answers each to the runner that asked, and denies unasked what control.ts would deny a session's (too many waiting, an input it can't show whole, an unusable tool name). |
| `turn.ts` | One code turn of the code driver (./job-driver.ts): the claim, then `forge job advance` and one `forge job agent run` per spawn as child processes, acting on each child's end through the moves table (./moves.ts) until a gate, `done`, a park, a takeover, a usage limit, a procedure hand-off or a stop. |
<!-- forge:map:end -->
