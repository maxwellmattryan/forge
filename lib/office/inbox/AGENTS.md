# lib/office/inbox/

The inbox's requests answered in code: forge dash's intake runner, its per-type plans, the one-shot forge:triage child inside a `next`, and the pool's `forge` children (the periodic sync and Office pass, and the intake calls).

- Every `forge` call the runner makes is its own `bin/forge` child (`runForgeCall`, `children.ts`) in the `_inbox` scope with the session env, the pool's trusted digest and the write roots, so the CLI's inbox refusals apply to each one. Never call a command's function in-process from here: `gh` would stall the server, and the refusals would not run.
- A run claims under the inbox's one intake session id (`ensureIntakeSessionId`, kept as `intakeSessionId` in `_inbox.json`) and never leaves the request claimed: an answer acks it, a stop gives it back with `releaseClaim` (not counted), a child that never answered requeues it through `requeueOrphanedRequests` (counted, once) and holds new runs for the backoff. `lib/office/driver.ts` counts the id among the inbox's ids but never among a session record's (`recordIds`).
- A request value reaches argv only as one `--flag=<value>` word, or after `--` for a run's ref, and only after its check in `handlers.ts`; a job id from a child's output passes `validJobId` first. Acks and log lines hold only job ids, counts and Forge's own error text, never a tracker title or claude's text (the triage reply only as one capped `TRIAGE:` line).
- The triage child (`triage.ts`) writes only its batch dir: one `Edit(//<batch dir>/**)` allow rule under `dontAsk`, `--tools Read,Write`, no setting source, the write guard's roots set to the triage dir, and every protected-path deny rule but `.forge/runtime/**`. After it exits the confine digest is compared with the pool's baseline, and a change stops the pool before `--apply`.
- Design: [Daemon](../../../docs/architecture/daemon.md) › Intake runner, [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `children.ts` | The `forge` children of `forge dash`: the periodic `forge sync` and Office pass (`forge office pass`), outside any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or program the checkout's config names never runs on their fetches; and the intake runner's calls (runForgeCall), in the `_inbox` scope with the session env, whose JSON and exit code are the request's answer. |
| `handlers.ts` | The intake runner's per-type plans: for each request type the inbox gets, the fixed `forge` calls that answer it, in order, and the one-line ack built from their JSON. |
| `runner.ts` | forge dash's intake runner: answers the inbox's requests in code, one at a time, oldest first, instead of turning a headless inbox session. |
| `triage.ts` | Readiness triage inside a `next` request: `forge tracker triage --limit=10`, then one headless `claude -p --agent forge:triage` child that reads the batch's fenced items and writes its verdicts, then `forge tracker triage --apply=<batch>`. |
<!-- forge:map:end -->
