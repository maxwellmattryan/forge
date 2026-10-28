# Investigation: a job parks on issue-link after a Foreman spec approval with no dashboard prompt

- **Date:** 2026-10-27, for issue #572 (incident on 2026-10-26, job `settings-modal-forge-and-project-s5g2`).
- **Code cited at:** develop `f4337275`. Every `path:line` below is at that commit. The incident itself ran on `4209ebc2` (the job's merge base). Between the two, #609 (`f2c94550`) moved the Foreman's gate decisions out of the `_assistant-1` daemon session and into `forge dash`'s gate runner. `dashboard/src/lib/decision.ts`, `lib/core/job/requests.ts`'s claim and requeue rules and the job scope of `skills/forge/reference/requests.md` did not change in ways that matter here, so each finding still holds at `f4337275`.
- **Sources** (read-only, relative to `.forge/`): `jobs/settings-modal-forge-and-project-s5g2/events.jsonl` and `job.json`; `runtime/requests/1793040383075-1osm.json`, `1793040622204-nq1c.json`, `1793040664554-e6yd.json` and `1793041107286-zcyx.json`; `runtime/audit.jsonl` (it has no entries between 2026-10-26 18:40 and 19:20); `runtime/daemons/settings-modal-forge-and-project-s5g2.log` (job session `8c9c9903`), `runtime/daemons/_assistant-1.log` (assistant Foreman `0542f6ad`) and `runtime/daemons/_inbox.log`; `runtime/chats/`. Outside `.forge/`, one more source: the owner's interactive Claude Code session that unstuck the job, which holds the owner's words at 18:57:01.

## Summary
- **Lead 1:** job session `8c9c9903` claimed the 18:46 `resume` and ran the job until the `spec-approval` park. It then ended its turn there without `forge requests ack`. Nothing in code acks a `resume`. Later turns list only `pending` requests, so the session never saw it again. While the session held the job's lease, `requeueOrphans` couldn't return it to the queue either. So it stayed `in-progress` from 18:46:41 to 19:17:04. Confirmed.
- **Lead 1 (dashboard):** `decisionInFlight` returns that request for the whole `issue-link` park. `JobActions.svelte` therefore swapped every control, `IssueLinkActions` included, for "Applying: a decision sent from elsewhere". Reproduced.
- **Lead 2:** `issue-link` is not in `OFFICE_GATES`, so `maybeEnqueueGate` queues no `gate` request for it. The Foreman is also barred from linking, so its `approve-spec` handed the job to an owner-only park and told no one. Confirmed.
- **Lead 3:** no record holds "already approved". The owner's words paraphrase the Needs-you card or drawer, whose status line claimed a decision was being applied and doesn't mention `issue-link`. Inferred.
- **Lead 4:** a dashboard answer would have moved the job. It queues a request in the job's scope, the pool turns `8c9c9903`, and that session renews its own lease. The lease wasn't the blocker. The blocker was that `forge job human` queues no request. Inferred, with the routing confirmed.
- **Combined:** the Foreman cleared the gate it was allowed to decide and left the one it wasn't. That gate belonged to the owner, but a `resume` the job session forgot made the dashboard hide its controls behind a false "decision in flight" line.

## Timeline
Request ids are shortened to their suffix (`1osm` is `1793040383075-1osm`). "Lease" is the job's lease driver (8-character prefix).

| Time (UTC) | What happened | Gate (`waitingOn`) | Open requests for the job (status, session) | Lease | Source | Status |
|---|---|---|---|---|---|---|
| 18:46:23 | Session `1f472f2d`, which created the job, releases it and hands off `resume` `1osm` (from `cli`). The pool spawns job session `8c9c9903` | none (backlog, queued) | `1osm` pending | none | events `released`; `1osm.createdAt`; daemon log `spawn` | confirmed |
| 18:46:35–41 | `8c9c9903` claims the job (epoch 2), then claims `1osm` | none | `1osm` in-progress (`8c9c9903`, `updatedAt` 18:46:41) | `8c9c9903` | events `claimed`; daemon log, result of `forge requests claim` | confirmed |
| 18:50:22 | Spec writer done. SP5 parks the job, and the park's move queues `gate` `nq1c` | `spec-approval` ("spec ready, issue unlinked") | `1osm` in-progress (`8c9c9903`); `nq1c` pending | `8c9c9903` | events `transition`; `nq1c.createdAt` 18:50:22.204 | confirmed |
| 18:50:27 | `8c9c9903` ends turn 1 at the gate and never runs `forge requests ack 1osm` | `spec-approval` | unchanged | `8c9c9903` | daemon log `result`, with no ack call in the turn | confirmed |
| 18:50:38 | The assistant Foreman claims `nq1c` | `spec-approval` | `1osm` in-progress; `nq1c` in-progress (`0542f6ad`) | `8c9c9903` | `_assistant-1.log` | confirmed |
| 18:51:02 | The Foreman records `approve-spec` with no link | `spec-approval` | unchanged | `8c9c9903` | event `human`, `actor.source: foreman` | confirmed |
| 18:51:04–06 | The Foreman queues `resume` `e6yd` (from `daemon:_assistant-1`) and acks `nq1c` `done` | `spec-approval` | `1osm` in-progress; `e6yd` pending; `nq1c` done at 18:51:06 | `8c9c9903` | `e6yd.createdAt`; `nq1c.updatedAt`, `nq1c.result` | confirmed |
| 18:51:12–15 | The pool turns `8c9c9903` (turn 2). It re-claims the job (epoch stays 2) and claims `e6yd`. The spec gate clears, then SP7 parks the job. No `gate` request is queued | `issue-link` ("link an issue before build") | `1osm` in-progress; `e6yd` in-progress (`8c9c9903`) | `8c9c9903` | events `claimed`, `transition`; daemon log; no request with `args.gate: issue-link` | confirmed |
| 18:51:18–21 | `e6yd` acked `done`: "resumed; spec approved, now waiting on issue-link". Turn 2 ends | `issue-link` | `1osm` in-progress (`8c9c9903`) only | `8c9c9903` | `e6yd.result`; daemon log | confirmed |
| 18:51:21–18:58:13 | The dashboard's controls for the park are hidden behind the in-flight status line | `issue-link` | `1osm` in-progress | `8c9c9903` | Lead 1 reproduction; no record of the rendered page | inferred |
| 18:57:01 | The owner asks an interactive session to nudge the job, saying "it says it was already approved" | `issue-link` | unchanged | `8c9c9903` | the owner's interactive session | confirmed |
| 18:58:13 | The owner's `forge job human … approve --link none` logs `issue-link` `none: true` and `human` `approve` (`actor.source: gh`). Nothing moves | `issue-link` | `1osm` in-progress | `8c9c9903` | events | confirmed |
| 18:58:27 | The release `resume` `zcyx` (from `cli`, with `--session 8c9c9903…`) is queued, and the lease is released | `issue-link` | `1osm` in-progress; `zcyx` pending | none | event `released`; `zcyx.createdAt` | confirmed |
| 18:58:29–37 | The pool turns `8c9c9903` (turn 3). It claims the job (epoch 3) and `zcyx` | `issue-link` | `1osm`, `zcyx` in-progress (`8c9c9903`) | `8c9c9903` | daemon log `turn`; event `claimed` | confirmed |
| 18:58:40 | GA5 answers the park, and SP6 moves the job to build, round 1. The job runs again | none (build, running) | `1osm`, `zcyx` in-progress | `8c9c9903` | events `transition`, `round` | confirmed |
| 19:14:38 | The job parks for PR review and the lease is released | `pr-review` | `1osm`, `zcyx` in-progress | none | events `transition`, `released` | confirmed |
| 19:17:04 | `1osm` returns to `pending` with `requeues: 1`. Its claim is over 30 minutes old and no lease covers it any more | `pr-review` | `1osm` pending; `zcyx` in-progress | none | event `note` ("is pending again: the session handling it ended"); `1osm.requeues` | confirmed (which rule fired is inferred from code) |
| 19:17:13–19 | `8c9c9903` (turn 6) claims the job (epoch 5) and `1osm`, runs one advance and acks `done`: "stale resume (requeued); job already at pr, PR #574 waits on review" | `pr-review` | `zcyx` in-progress | `8c9c9903`, released at 19:17:16 | `1osm.updatedAt` 19:17:19.193, `1osm.result`; daemon log | confirmed |
| 19:29:21 | `zcyx` closes the same way, `done` with the same result | `pr-review` | none | none | `zcyx.updatedAt`, `zcyx.result` | confirmed |

## Lead 1
**Cause.** The job session's model claims and acks requests by hand, following `skills/forge/reference/requests.md`. Line 11 says to claim, handle and then ack each request. Line 8, for the job scope, says to "End the turn at any gate". The two lines never say what happens to a `resume` when the step loop parks. In turn 1, `8c9c9903` claimed `1osm` (`forge requests claim` → `claimRequest`, `lib/core/job/requests.ts:213`), ran the planner and spec writer, reached the `spec-approval` park and ended the turn without `forge requests ack` (`lib/cli/commands/requests.ts:148` → `ackRequest`, `requests.ts:303`). In turn 2 it acked `e6yd` at the next park. The model was inconsistent, and the procedure left it room to be. No code acks a job session's `resume`. The only `ackRequest` callers are the CLI, the gate runner (gate requests only, `lib/office/foreman/run.ts:190`) and job delete (`lib/engine/ops/delete.ts:66`). `forge requests` lists only `pending` items (`lib/cli/commands/requests.ts:91`, `listRequests` at `requests.ts:182`), so the session never saw `1osm` again. `requeueOrphans` (`requests.ts:242`) leaves an in-progress claim alone while that session holds a live lease on the job. Rule (a) needs an expired lease, and rule (c) skips leased claims (`requests.ts:265-269`). The session renewed its lease each turn, so the claim stood until the 19:14:38 release. Rule (c) fired at the first reconcile pass after 30 minutes (`CLAIM_STALE_MS`, `requests.ts:202`). The same thing happened to `zcyx`, open from 18:58:37 to 19:29:21: the session claimed it, started the builder in the background and ended the turn.

The dashboard side: `decisionInFlight` (`dashboard/src/lib/decision.ts:53`) picks the newest open request for the job (`open`, `:26`) whose type is in `DECISION_TYPES` (`:24`, `resume` included). It doesn't compare that request with the time of the current park (`:61-63`). From 18:51:18 to 18:58:13 the only open request of those types was `1osm`. `e6yd` was done, `nq1c` is a `gate`, and `zcyx` didn't exist yet. `JobActions.svelte:33` derives `flight` from it. `:70-76` then shows the status line and hides the control block, which includes `IssueLinkActions` (`:78`). The line reads `inbox.decision.applying` with `inbox.decision.elsewhere` (`dashboard/src/messages/en/statusbar.json:194-195`): "Applying: a decision sent from elsewhere. A job session is moving the gate."

Reproduction, run from the worktree (Node ≥ 22.18, which strips the types). It prints the view for the recorded `1osm` fields and, as a control, for the same request once it is `done`:
```bash
node --input-type=module -e "import { decisionInFlight } from './dashboard/src/lib/decision.ts'; const r = { id: '1793040383075-1osm', type: 'resume', job: 'settings-modal-forge-and-project-s5g2', from: 'cli', status: 'in-progress', createdAt: '2026-10-26T18:46:23.075Z' }; console.log(JSON.stringify(decisionInFlight(r.job, undefined, [r]))); console.log(JSON.stringify(decisionInFlight(r.job, undefined, [{ ...r, status: 'done' }])));"
```
```
{"label":null,"type":"resume","phase":"applying"}
null
```
So, yes: for this job, `decisionInFlight` returned the 18:46 `resume` from 18:51:15 to 18:58:13, and the `issue-link` controls were hidden.

**Evidence.** `1osm`: `createdAt` 18:46:23.075, claimed `in-progress` at 18:46:41 (daemon log, result of `forge requests claim`), `requeues: 1`, `updatedAt` 19:17:19.193, and `result` "stale resume (requeued)…". That result string is not in `lib/`: the session wrote it with `forge requests ack` in turn 6. Event `note` at 19:17:04. Turn 1 of the session log has no ack call. `_inbox.log` shows the inbox session refusing every turn on the trust check, so it handled none of these requests.

**Status.** Confirmed: the session log, request records and events show the claim with no ack and the requeue, and the `decisionInFlight` result is reproduced. What the page actually rendered is inferred, since no record of it exists.

**Direction.** A `resume` should leave the queue when the job session's turn ends, acked by code (the pool, after the turn, for requests the session claimed) rather than by the model. On the dashboard, a request created before the job entered its current park should not hide that park's controls. It can't be an answer to a gate that didn't exist yet. `decisionInFlight` should ignore requests older than the park, and `resume` should never hide a gate it doesn't answer.

## Lead 2
**Cause.** A park queues a `gate` request through `maybeEnqueueGate` (`lib/engine/pipeline/moves/foreman-gates.ts:260`), and only for a class that `gateClassFor`/`gateClass` (`:49`, `:41`) returns and `decides(config)` lists (`:263`). `gateClass` keeps `waitingOn` only when it is in `OFFICE_GATES` (`lib/api/constants.ts:83`; `isGateClass`, `foreman-gates.ts:35`). `issue-link` is a `WAITING_ON` value (`constants.ts:32`) but not a gate class, so the `issue-link` park returns `null` at `:263` and no request is queued. A Foreman `approve-spec` can't record a link today. `ACTIONS_BY_GATE['spec-approval']` (`foreman-gates.ts:15`) offers only `approve-spec` and `revise-spec`, and `checkForemanDecision` (`lib/office/foreman/policy.ts:218`) refuses any `--link` or `--reason` ("linking an issue stays a human call", `:232`). A person's `forge job human` takes `--link` with `approve` and `approve-spec` (`lib/cli/commands/job/decide.ts:41-43`). The spec stage parks twice: SP5 (`lib/engine/pipeline/step/stages/spec.ts:72-75`) parks on `spec-approval` with reason "spec ready, issue unlinked", and once a spec is approved without a link, SP7 (`:78`) parks on `issue-link`. GA5 (`lib/engine/pipeline/step/answered.ts:46`) answers `issue-link` with `approve`. `gateOwner` (`policy.ts:41`, `:45`) reports `human` for `issue-link`. The owner owned the second park and had the controls for it (Lead 1 hid them), but nobody told the owner that the Foreman's approval had passed the job to them.

Reproduction, from the worktree:
```bash
node --input-type=module -e "import { gateClass } from './lib/engine/pipeline/moves/foreman-gates.ts'; for (const [w, r] of [['spec-approval', 'spec ready, issue unlinked'], ['issue-link', 'link an issue before build']]) console.log(w, '->', gateClass({ state: 'waiting', waitingOn: w, reason: r, repos: [] }));"
```
```
spec-approval -> spec-approval
issue-link -> null
```

**Evidence.** `nq1c`: `args.gate: spec-approval`, `from: forge`, created 74 ms after the 18:50:22 transition. The Foreman's `approve-spec` at 18:51:02 carries no `issue-link` event. The SP7 transition at 18:51:15.101 has no request after it until the owner's `zcyx`. `config.yml`'s `foreman.decides` doesn't list `issue-link`, and can't, because `lib/core/config/validate.ts:236` rejects any non-gate class.

**Status.** Confirmed.

**Direction.** Of the three directions, pick **`issue-link` always goes to the owner**. Linking is a tracker write (`new` files an issue) and a scope call that the policy keeps from the Foreman on purpose (`policy.ts:232`). Giving the Foreman a link decision, or giving `issue-link` its own `gate` request, would either widen that authority or queue a request nobody may decide. To avoid the hidden two-step, an unlinked job's spec gate should stay with the owner as well. Its combined link-and-approve controls already exist (`specLinkPending`, `dashboard/src/lib/inbox.ts:58`; `JobActions.svelte:78`), so the owner answers both at once.

## Lead 3
**Cause.** No recorded surface uses "already approved". The phrase is the owner's own, typed at 18:57:01. The likeliest source is the Needs-you card or the drawer's action dock. Both render `JobActions` (`dashboard/src/components/InboxCard.svelte`, `dashboard/src/components/statusbar/NeedsPanel.svelte`, `dashboard/src/components/ActionDock.svelte`), which showed the status line from Lead 1, "Applying: a decision sent from elsewhere. A job session is moving the gate.", in place of any button. That line says a decision is under way and doesn't mention `issue-link`. The card's gate label did name the park ("Issue to link", `WAIT_LABEL`, `dashboard/src/lib/labels.ts:8`), so the two contradicted each other. Two other places in the drawer read as approved: the Thread (`threadItems`, `dashboard/src/lib/thread.ts:120`) and the timeline. The Thread listed `nq1c` as an approve (`threadAction` falls back to the `approve` verb, `:116`) with the result "approve: scope matches request, ACs name their proof, no reserved topic". After it came `e6yd`'s result "resumed; spec approved, now waiting on issue-link", which does mention `issue-link`. The timeline showed `approve-spec` with the Foreman chip (`eventDetail`, `dashboard/src/lib/drawer.ts:91`), then the `issue-link` transition with its reason.

| Candidate | Checked | Outcome |
|---|---|---|
| Needs-you card, drawer action dock | `JobActions.svelte:70-78`, `statusbar.json:194-195`, Lead 1 reproduction | likeliest: a decision "applying", no `issue-link` in the line (the gate label shows it) |
| Thread | `thread.ts:88-135`; `nq1c.result`, `e6yd.result` | "approve…" and "spec approved, now waiting on issue-link": mentions `issue-link` |
| Drawer timeline | `drawer.ts:91`; events at 18:51:02 and 18:51:15 | `approve-spec` row, then the `issue-link` transition |
| Notification | `lib/office/notify.ts:36`, `:440`; `config.yml` | ruled out: no `notify` targets configured, no `notified` events |
| Server or CLI response | `lib/` text search | ruled out: "already approved" exists only for release plans (`lib/engine/release/approval.ts:131`, `lib/engine/release/mandate.ts:377`) |
| Inbox, office and chat sessions | `_inbox.log`, `_office.log`, `runtime/chats/` | ruled out: the inbox refused every turn on the trust check, and neither the office log nor the one chat mentions the job |

**Evidence.** The owner's message at 18:57:01. `1osm` `in-progress`, `e6yd.result` and `nq1c.result`, plus the reproduction in Lead 1.

**Status.** Inferred: nothing records what the page rendered. The candidates above were each checked.

**Direction.** A park the owner must answer should never show a "decision in flight" line for a request that can't answer it (Lead 1). When the Foreman decides a gate and the job lands on an owner-only gate, the card should say whose move it now is.

## Lead 4
**Cause.** A dashboard answer would have moved the job while `8c9c9903` held the lease. "No issue needed" posts an `approve` with `args.link: none` (`postRequest`, `lib/server/routes/jobs.ts:139`; link args checked at `:441-443`). `resumeHeld` (`:401`) checks only `resume`, and it lets the job's own session's lease through (`Drive.held`, `lib/office/driver.ts:59-63`). `enqueue` (`requests.ts:151`) routes `approve` to the job's scope (`requestScope`, `:109`), and the pool's tick turns that job's session for its `pending` requests (`lib/office/pool.ts:268`). The session's `forge job claim` takes back its own lease without `--force` (`claimJob`, `lib/core/job/store.ts:433`: same driver, epoch kept). It then records the link through `forge job human` and runs the step loop. The CLI answer at 18:58:13 didn't move the job because `forge job human` writes events and queues nothing. No request meant no turn. The reconciler doesn't help either, because it judges only `running` jobs (`reconcile`, `lib/office/reconcile.ts:163`). `docs/CLI.md:250` documents exactly this ("`forge job human` followed by `forge requests add resume --job <id>` is enough from any session"), though its opening words, "A recorded decision moves the job by itself", overstate it. Releasing the lease with `--session` (`releaseJob`, `store.ts:463`, called from `lib/cli/commands/requests.ts:133`) was harmless but not needed. A bare `resume` would have turned the same session, which renews its own lease. The request-level code (`claimRequest`, `releaseClaim` at `requests.ts:289`, `requeueOrphans`) plays no part in that hand-off.

**Evidence.** At 18:51:04 `e6yd` was queued with no lease release (no `released` event). The pool turned `8c9c9903` at 18:51:05, and the session re-claimed the job at 18:51:12 with epoch still 2. After the 18:58:13 events the session logged no turn until `zcyx` at 18:58:27.

**Status.** Inferred for the `approve` path specifically. The routing, the turn and the re-claim are confirmed by the `e6yd` turn.

**Direction.** When a person runs `forge job human` in their own terminal and it answers the job's current park, it should queue the job's `resume` itself while a `forge dash` runs. `docs/CLI.md` should then describe that, instead of "moves the job by itself".

## Follow-up issues
Two defects are already covered by open issues, so those sections cite the issue instead of drafting a new one. This investigation adds the evidence above to each:
- **#583** (Resume requests stay pending after the job session has acted on them) covers the engine half of Lead 1. Here the request stayed `in-progress`, not `pending`. The session ended its turn at a park without acking, and `requeueOrphans` won't touch a claim while its session holds the job's lease.
- **#584** (Dashboard: a stale resume request hides a gate's buttons behind "decision sent from elsewhere") covers the dashboard half of Lead 1, and the false status line that Lead 3 points to.

### F1: Keep an unlinked job's spec gate with the owner, so a Foreman approval can't strand it on issue-link
**Why.** When the Foreman approves the spec of a job with no linked issue, the job parks straight away on `issue-link`. That gate queues no `gate` request and the Foreman may not decide it, so it lands with the owner, and nothing tells the owner. Linking is a tracker write the Foreman is barred from on purpose, so the fix is to leave the whole decision with the owner: they answer spec and link together through the existing combined controls.

**Leads.** 2 and 3 in `docs/design/issue-link-park-investigation.md` (#572).

**Acceptance criteria.**
- [ ] A job that parks on `spec-approval` with its issue link missing (reason "spec ready, issue unlinked") queues no `gate` request, and `gateOwner` reports `human` for it.
- [ ] A linked job's `spec-approval` park still queues a `gate` request, as today.
- [ ] The dashboard shows that unlinked spec park with its link-and-approve buttons (`IssueLinkActions` with `approving`) and the "you" owner badge.
- [ ] `docs/architecture/foreman.md` and `docs/CONFIG.md` (`foreman.decides`) say an unlinked job's spec gate stays with the owner.

**Where.** `lib/engine/pipeline/moves/foreman-gates.ts` (`maybeEnqueueGate`), `lib/office/foreman/policy.ts` (`gateOwner`, `checkForemanDecision`), `lib/engine/pipeline/step/stages/spec.ts` (SP5, SP7), `lib/core/job/issue-link.ts` (`issueLinkStatus`).

### F2: `forge job human` in a person's terminal queues the resume that moves a pool-driven job
**Why.** A person who answers a park with `forge job human` while `forge dash` runs sees `ok: true`, but the job doesn't move. No request reaches the job's session, and the reconciler skips waiting jobs. `docs/CLI.md` says "A recorded decision moves the job by itself", then adds that a `resume` must follow. On #572 the owner had to find that out, and release the lease by hand as well, which wasn't needed.

**Leads.** 4 in `docs/design/issue-link-park-investigation.md` (#572).

**Acceptance criteria.**
- [ ] Outside a daemon session, with a `forge dash` running, a `forge job human` decision that answers the job's current park queues one `resume` for the job (`from: cli`) and returns its id in the JSON.
- [ ] With no `forge dash` running, or for a decision that doesn't answer the current park, it queues nothing, as today.
- [ ] Inside a daemon session it queues nothing, so the job session never queues itself a request it would then have to ack.
- [ ] `docs/CLI.md` describes the queued resume in place of "moves the job by itself".

**Where.** `lib/cli/commands/job/decide.ts`, `lib/office/reconcile.ts` (`dashRunning`), `lib/core/job/requests.ts` (`enqueue`, `daemonScope`), `docs/CLI.md`.
