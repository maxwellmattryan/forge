# Foreman: the director loop and office runs

Part of [Foreman](../foreman.md).

## Director loop

### The Office pass

Enforcement is code and judgement is the model's. The **Office pass** (`forge office pass`, `lib/office/mandates/pass.ts`) is deterministic code with no model, which `forge dash` runs as a child (`runPassChild`, outside any daemon scope, with sync's env and git pins) every `foreman.cadence` minutes, at pool start, when a mandate file changes and when a job session's result leaves a mandate job `done`, `cancelled`, `failed` or `waiting` (docs/architecture/daemon.md "Periodic Office pass"). It is refused in every daemon session, the office's included, and writes nothing with `foreman.enabled` off.

Under the `<locks>/office` lock it reads every mandate, skipping goal mandates whose scope is still empty and following up closed ones (the final card, below), and for each other one, in creation order:
- applies `onUnfinishable` to every failed job (`cancel` moves it to `cancelled`; `park` leaves it failed), logging a `mandate-unfinishable` job event that makes the job **handled**;
- stalls each in-flight job the bounce hold holds, once per park (`mandate-stalled` job event, `mandate-stalled` notification with the job);
- **closes** an active or paused mandate with no tracker error, no candidates, no in-flight and no unfinishable job, writing its closing summary (`.forge/runtime/mandates/<id>/summary.json`, versioned in `lib/core/versions/mandate-summary.ts`), which carries the mandate's report card built from the same progress at the close time (`buildReportCard`, `lib/engine/metrics/report-card.ts`, the builder `forge stats --mandate` and `GET /api/mandates` use for the live card), queuing the mandate's retro (below), and evaluating again every mandate whose `after` is the closed one, so the next link of a chain starts in the same pass (an effective `until: released` mandate first waits for its release, [A mandate's release](releases.md#a-mandates-release), and is neither paused nor stalled meanwhile);
- pauses an active mandate at its budget (`spentUsd >= budget.usd`, or `started >= budget.jobs` with candidates left);
- otherwise pauses one below its **quality floor** (`qualityFloor` in `progress.ts`: `quality.pauseBelow` set, at least `quality.minScored` merged jobs scored 0-5, and their running median, `runningScore` in `report-card.ts`, strictly below the floor; reason `quality: median <m> below pauseBelow <f> over <n> scored jobs`, notification `mandate-stalled` with the reason `mandate-quality`);
- and otherwise pauses an active mandate with no progress for `stall.cadences × foreman.cadence` minutes (no job created or moved, no running agent).

At most one pause lands per pass, in that order. A mandate the owner resumes while still below its floor stays blocked (`start` refuses it) and the next pass pauses it again.

**The retro at close**: when a mandate moves to `closed`, by the pass's close or by the owner's (`mandateWrite`'s `close` that writes, from `forge mandate close` or the Foreman page), `queueMandateRetro` (`lib/engine/evals/retro.ts`) queues one `{type: "retro", job: null, args: {mandate}, from: "forge"}` over the mandate's live and archived jobs, under the `<locks>/retro-queue` lock the cadence retro takes, and the caller logs a `retro` directive (`queued request <rid> over <n> jobs`) with its own actor: the foreman for the pass, the owner for a close. It queues none with the foreman off, for a mandate with no jobs (a rejected goal draft), or when a `retro` request for that mandate exists in any status, so it is once per mandate and a scan never queues retros for mandates closed before.

The inbox turns it into a retro job scoped by `forge retro prepare --mandate` (docs/IMPROVEMENT.md §3), whose spec gate stays a human's; nothing on this path writes `.forge/notes/`, `.forge/reviewers/` or `.forge/config.yml`. `enqueue` and `POST /api/requests` refuse a `retro` request whose `args.mandate` is not a mandate id, and the CLI checks it again with `mandateTarget`, since the inbox puts it on a command line.

**The final card**: the closing summary carries `outcomesFinalAt`, the close time when the card at close had no open outcome, else `null`. For each closed, readable mandate whose summary reads with no problem and `outcomesFinalAt: null`, each pass builds the live card (`jobFigures` over the pass's records, `buildReportCard` at the pass time) and, once it has no open outcome, rewrites `summary.json` once through `writeSummary` (a confined dir and an atomic replace, under the office lock): the new card and `outcomesFinalAt`, every other field as written at close. The pass's result lists those mandates as `finalized`.

A closed mandate with no summary, or an unreadable one (`readSummary` reads through `readRegular`, so a planted link is refused), is skipped. Each status write goes through `writeMandate` with the foreman as the audit actor, and lands only while the mandate still has the status and `updatedAt` the pass read, so an owner's edit, pause or close wins.

### Directing

When some active, unblocked mandate has a candidate window or a resumable job and no `direct` request is pending or in progress, the pass queues one `{type: "direct", job: null, args: {}, from: "forge"}`; `requestScope` sends it to `_office`, and nothing else writes one (`forge requests add` and `POST /api/requests` refuse it).

A mandate's **jobs** are the live jobs (the CLI records) and archived jobs whose `mandate` is its id, classed against its effective `until` as reached (`merge-ready`: done, or at `pr` waiting on `pr-review` with a PR; `merged` and `released`: done), handled, unfinishable or in flight. Its spend is every ledger bucket of those jobs (never the office runs' own spend, which stays under `daemon.dailyUsd.office`), and `started` counts jobs whose parent is not one of its own, so split children don't count.

Its **candidates** are the scope items (`order: listed`: the written issues, with no tracker call; otherwise one `Tracker.scope` call per milestone, or one for labels alone) that are not needs-info, carried by no live job and not skipped, ordered as written, by priority then number, or by number (`graph`: the Foreman orders them by the issues' stated dependencies), and taken from the first milestone that still has open work. The **window** is the first `free` candidates under `listed` and the first `min(10, 3 × free)` otherwise, empty while the mandate is blocked (not active, at its budget, below its quality floor, the repo budget held, a tracker error, or the foreman off).

On a `direct` request an office run (Office runs below) runs `forge office survey`, which lists each active mandate's window with one-line titles, its resumable jobs, its latest 5 directives and its guidance fenced; with `foreman.surveyors.enabled` it runs `forge office board <id>` for each mandate with work in flight and hands the brief to a `forge:surveyor` (Read only, at most 5 `SURVEY:` lines over a board of one fenced line per job); then it runs `forge office start <id> <ref> --reason R` for up to `free` candidates, `forge office resume` for resumable jobs, and `forge office note` for what it holds.

`start` re-checks everything under the office lock: the mandate is active and not blocked (a held repo budget exits 4), and the ref's stored form is in the window recomputed now (under `listed`, only the first). An issue the tracker reports closed or missing is skipped; otherwise `startFromRef` creates the job with `mandate` set and split mode never, claims the issue, and a `resume` with `args.intake: run` is queued. The director call runs on `foreman.model` and `foreman.effort` (`--model` replaces every one in `daemon.command`).

Each choice and enforcement is a **directive**, a `directive` event in the repo audit log (and on the job it names) with `{mandate, action, issue, job, reason, actor}`, the action one of `start`, `resume`, `note`, `skip`, `pause`, `close`, `stall`, `park`, `cancel`, `release` (the pass planned a mandate's release) or `retro` (a mandate's close queued its retro); `forge audit`, `forge job audit` and `forge mandate show` (with `progress` and the closing `summary`) list them.

## Office runs

Code: `lib/office/foreman/runs/`.

The office session is retired: `forge dash`'s pool owns an **office runner** beside the gate runner, and no session serves `_office` (`pool.startSession('_office')` and `setPermissionMode('_office', …)` answer `OFFICE_NO_SESSION`, and a stop is a no-op). While `daemon.enabled` and `foreman.enabled` hold, each tick hands it the pending `draft` and `direct` requests, oldest first, and it runs **one office run at a time**: it claims the request as `office-run:<uuid>`, runs its steps and acks; a run never leaves a request claimed. A `draft` whose `args.mandate` is no mandate id, or any other type, is acked `rejected` `invalid office request`.

The steps run as children: the CLI ones through `officeArgv`, which builds only `mandate draft prepare|record` and `office survey|board|start|resume|note`, every value pattern-checked (a mandate id, a request id, a job id, a UUID agent id, a ref with no control character), the positionals after `--` and the reason one cleaned `--reason=` word, spawned as `process.execPath bin/forge` in the repo with stdout kept (`runChildOutput`, 4 MiB, the sync child's kill and timeout); and the model ones as headless `claude -p --agent forge:<drafter|surveyor|director>` children (`runRoleChild`), the brief their only stdin message, under `--permission-mode dontAsk` with Bash denied and `--max-budget-usd` set to what is left of the office cap.

Every child, CLI and model, gets `FORGE_DAEMON=1`, `FORGE_DAEMON_SCOPE=_office` and the pool's trust digest, so the CLI's office refusals apply and directives keep the foreman actor.

A **draft run** is the [drafting run](mandates.md#intake): prepare's refusal acks `rejected` (outcome `refused`), `stale: true` acks `done` `stale: <reason>` with no model child; otherwise one drafter on prepare's model and effort, with tools `Read, Grep, Glob, Write` and one write root, the drafts dir computed in-process (`draftsDir`, never prepare's `staging`), then record with the drafter's session id as `--agent-id`.

A **direct run** surveys; with no candidate and no resumable job anywhere it acks `done` `nothing to direct`. With surveyors on, it runs a board and starts one `forge:surveyor` (tools `Read`, no write root) per mandate with work in flight, all at once, and keeps at most 5 cleaned `SURVEY:` lines each; a refused board skips its mandate.

Then it plans each mandate with a free slot and a candidate: **decided in code** under `order: listed`, or when its candidates fit its free slots with no guidance and no `SURVEY:` lines (the start list is the candidates in survey order, reason `next listed issue` or `fits the mandate's free slots`); every other such mandate is **asked**, and with any asked the run makes exactly one **director call**, a `forge:director` on `foreman.model` and `foreman.effort` with tools `Read`, whose brief (`directorBrief`, within `briefLine`'s cap: recent directives go first, then each mandate keeps 20 candidates) fences the titles, the guidance and the `SURVEY:` lines as data.

Its reply's last non-empty line must be `DIRECT: {"start":[{"mandate","ref","reason"}…],"hold":[…]}`, at most 16000 characters, exactly those keys, at most 50 entries a list, each mandate an asked one, each ref exactly one of its candidates, each reason non-empty once cleaned, no pair twice (`parseDirect`); anything else starts nothing, and each asked mandate gets one note `director reply unparseable: started none of <n> candidates`. No start, resume or note runs until every model child has ended.

Then, mandate by mandate in survey order, it starts until `free` starts succeeded (a `skipped: true` tries the next ref, a listed mandate surveys again for the issues after a skipped one, and any non-zero exit stops starting for that mandate), notes `held <ref>: <reason>` per held ref (an asked mandate with neither gets `the director started none of <n> candidates`), and resumes each resumable job (`resumable: queued with no live lease`; a refusal is logged). It acks `done` `started <n>, resumed <m>`, with `, held <k>` when anything was held.

**Failures**, as for gate runs: a model child that ends without a result, a CLI child that crashes (no JSON, a signal, a timeout, exit 5) or any non-ForgeError requeues the request through `requeueOrphanedRequests`, counted, and the second rejects it with `REQUEUE_REJECTED` (outcome `failed`), each followed by the backoff; a pool stop, a usage limit (which holds the runner until it resets), a refused launch, the office cap reached before a model child or claude's `--max-budget-usd` stop gives the claim back with `releaseClaim`, uncounted (`requeued`); a ForgeError in-process acks `rejected`; and at a fresh pool start every `draft` or `direct` request left in progress under an `office-run:` session is requeued, counted.

After a model child ends, the confine digest is compared with the pool's baseline: a changed protected path stops the pool (`ctx.untrusted`), and the run records nothing and gives the claim back. **Cap**: each model child's costed result is metered once to `.forge/runtime/meter/_office.jsonl`, which `daemon.dailyUsd.office` sums with `_gates`; `take()` starts nothing while the cap is reached or a meter it sums can't be read, and the runner checks again before each model child, so the cap holds model-free direct runs too.

**Log**: one JSON line per event (`office-start`, `office-step` with the step and its exit, `office-child` with the agent, pid, model and effort, `office-end` with the outcome, the cut reason, the model calls, usd and tokens, `office-held`, `error`) to `.forge/runtime/daemons/_office.log` with `openAppend`, never claude's text or a CLI child's stdout; `forge daemon log --office` prints it. `/api/state`'s `daemons.office` is the runner's `OfficeRunsState` (`{enabled, live, held, runs}`, the last 50 runs, not seeded across restarts), which the Office page's Office runs table shows. No session-usage file is written for office runs: `forge stats`' orchestrator `office` lane reads near zero, and the spend is in the `_office` meter (`forge spend`: Office runs) and the drafting ledger.

## Director threat model

The attackers: the director call (or a surveyor) misled by tracker titles, mandate guidance or a surveyor's lines; a job, inbox or chat session or a gate run's assistant misled by tracker or PR text; the builder agent; and a Bash-capable session writing under its write roots (the job folders and worktrees, so a job folder's `job.json` and `events.jsonl` mirrors). Provenance stays the unauthenticated `FORGE_DAEMON_SCOPE`: the line guards a misled model, not a hostile local process (`FORGE_DAEMON= forge …` reads as a person). Each bypass fails.

- Starting an issue outside the mandate's scope or order: `start` recomputes the window from the tracker and refuses.
- Exceeding `maxJobs`, the mandate's budget or the repo budget, or starting under a paused, waiting or closed mandate: re-checked at `start`.
- Starting work from another session: `forge office survey|board|start|resume|note` are refused outside an office run (scope `_office`) and a person's terminal (`refuseOutsideOffice`).
- Triggering enforcement early: `forge office pass` is refused in every daemon scope.
- A forged `direct` request: refused from the CLI and the dashboard; a file-planted one costs at most one office run, under `daemon.dailyUsd.office`, and every action in that run is re-checked (a forged `draft` request also has to pass prepare's `boundRequest`).
- Hiding spend or membership by editing a job folder's `job.json`: progress reads the CLI records and the archive.
- Lifting a mandate over its quality floor: a high score forged in a job folder's `job.json` is never read (the floor, too, reads the CLI records and the archive), a malformed or out-of-range value (`9`, `'1'`, `NaN`) never counts, and the floor itself sits in the mandate file, outside every session's write roots, which only `forge mandate edit` outside a daemon session changes; the score value itself is the scoring pipeline's to trust.
- Resetting a bounce count with a fake `human` event in the job folder's `events.jsonl`: counts read `readEvents`, the CLI copy.
- A gate run deciding the K-th bounce, or a closed mandate's gate: refused by `mandateRefusal`.
- Injection through the board or the survey: titles and reasons are one line and fenced in the board, the guidance is fenced, the surveyor has `tools: Read` only, and its lines reach only the Foreman's choice among already-checked candidates.
- Option injection into gh or claude argv: milestones and labels never start with `-` (the contract, and the adapter's own throw), and `foreman.model` passes `validModel` (its pattern starts alphanumeric) and is its own argv word after `--model`.
- Notification text: fixed reason strings; the only free text is the mandate or job title, cleaned by `cleanText`.

The office runs add these:
- a prompt injection steering the director can name only asked mandates and refs among their survey candidates (`parseDirect`), it has Read only, no write root and `dontAsk`, and every start is re-checked under the office lock by `forge office start`;
- option injection through a ref, id or reason fails `officeArgv`'s checks (positionals after `--`, the reason one `--reason=` word), and model output reaches argv only as a ref that exactly matches a candidate;
- running anything but the office commands is impossible, since argv comes only from `officeArgv`'s seven commands and scope `_office` refuses job claims and merges in the CLI anyway;
- the drafter writing outside its staging file has only the drafts dir as a write root, no Bash and `dontAsk`, and a protected path any child changed stops the pool and records nothing;
- spend escaping the cap meets the `_office` meter, each child's `--max-budget-usd` and a cap check at `take()` and before every child (an unreadable meter holds both runners);
- and a request left claimed is requeued once, then rejected, given back on a stop or limit, or requeued by the boot recovery.
