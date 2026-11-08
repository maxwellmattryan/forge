# Foreman: mandates, intake and milestones

Part of [Foreman](../foreman.md).

## Mandates

A mandate (docs/CONFIG.md "Mandates") is the owner's standing instruction to the Office: `.forge/runtime/mandates/<id>.md`, runtime state outside every session's write roots, written by the owner only through `mandateWrite` (`lib/office/mandates/store.ts`), under one lock with every contract check before the write: `forge mandate new|edit|pause|resume|close`, refused in every daemon session, and the dashboard's Office page (`POST /api/mandates` and `/api/mandates/:id/edit|pause|resume|close`, behind the token, Origin and JSON guard, as `actor.source: dashboard`, docs/architecture/dashboard-security.md). An edit from the page is pinned to the `updatedAt` it read, so a CLI edit or an Office pass pause in between makes it a 409 rather than being overwritten.

A job joins one at creation (`forge job new --mandate`, or its split parent's) and keeps it: `mandate` is a locked field. For a job in a mandate, the classes the Foreman decides are `decides(config)` ∩ the mandate's written `decides`, whatever its status (except for `release`, below), read through `jobMandateDecides` from the CLI's record of the job (`stateFile`), never the session-writable `job.json` mirror.

Four places narrow: `checkForemanDecision` refuses, after the `foreman.decides` and class-reservation checks; a gate run's `approve-release` refuses the `release` class the same way (it has no park, so it goes through `checkReleaseDecision`, which takes the job's refusal from `mandateRefusal` after its policy checks and before its plan checks); `gateOwner` shows the gate as a human's; and assist (`gateAssist`, `forge job assist`) returns `reserved: "mandate <id>: …"`, after `classReservation` and before `reservedFor`, so the gate run's reserved path hands the gate off.

Engine code can't import `lib/office/`, so two engine paths take the narrowing as a function from the CLI: the CI rework in `forge pr sync` and `forge sync`, which a job in a mandate gets only when its mandate delegates `pr-feedback` (otherwise sync queues the gate, [Routing](gates.md#routing)), and `forge release run` and `forge release status`, which count a foreman `release-approval` only while the job's mandate still delegates `release`.

For the `release` class only, a paused or closed mandate also delegates nothing (`releaseMandateRefusal`), because publishing can't be undone: a gate run's `approve-release` is refused with `--actor foreman refused: mandate <id> is paused: release left for a human` (or `closed`), `forge job assist --gate release` reports it reserved, and an approval already recorded stops counting once the mandate narrows, pauses, closes, is deleted or can't be read. For every other class a paused mandate still delegates, so its in-flight jobs finish, and a **closed** mandate delegates nothing: `jobMandateDecides` returns `decides: []`, and `mandateRefusal` checks it first, refusing with `mandate <id> is closed: left for a human`.

The **bounce hold** comes after the decides check: a job waiting on a counted gate (every wait but `pr-review` and `external`) that it has entered `stall.bounces` times since a person's latest `human` event (`bounceHold`, `lib/office/mandates/progress.ts`, over `readEvents`, the CLI copy; a reason change while already waiting there is no new entry, and a foreman decision never resets the count) is a person's: `checkForemanDecision` refuses with `--actor foreman refused: mandate <id>: back at <W> <n> times (stall.bounces <k>): left for a human`, `forge job assist` returns that text as `reserved`, and `gateOwner` returns `human`. It is checked at decision time because a gate run decides a park within seconds, long before the next Office pass.

A mandate file that is missing or can't be read safely delegates nothing (fail closed). One engine path is not narrowed: `maybeEnqueueGate` (a queued request costs only the assist call that hands it off). When the gate is delegated, the assistant's brief carries a `Mandate:` line and the body fenced by `fenceImport`, and `forge mandate show` returns it fenced too, never raw.

## Mandate threat model

The attackers: a daemon session (a job session, the inbox, the office or a chat) or a gate run's `forge:assistant`, misled by tracker, PR or mandate-body text; the builder agent; and a Bash-capable agent writing files under its write roots.

Each bypass fails:
- detaching a job with `forge job set --field mandate=…` is refused (a locked field);
- editing `.forge/jobs/<id>/job.json` changes nothing Forge reads, because the narrowing reads the CLI record;
- widening a mandate's `decides` or creating a permissive one from a session is refused under `FORGE_DAEMON=1` before anything is read, the mandates dir is outside the session write roots (`lib/office/session/confine.ts`), and `decides` can never exceed `foreman.decides` minus reserved classes anyway;
- deleting, symlinking or corrupting the file makes the mandate unreadable, which delegates nothing;
- moving a split child to another mandate is refused;
- the body reaches briefs and `show` only fenced;
- milestones and labels, which reach `gh` as arguments through the tracker's `scope`, can't start with `-` or hold a control or hidden character (and the GitHub adapter throws on a leading `-` before gh runs);
- and the id grammar keeps the file inside the mandates dir.

Joining a mandate with `--mandate` is allowed from a session, because it only narrows.

The dashboard's Office page adds two more attackers, another site in the owner's browser and a local process holding the page token, and writes through the same `mandateWrite`: a cross-site POST that creates or widens a mandate fails the token, Origin and JSON guard; a cross-site read of the guidance fails the detail GET's token; a `decides` past `foreman.decides` or onto a `gate:<class>` reservation, a scope entry starting with `-`, or an id that climbs out of the mandates dir (`..%2F`, `none`, uppercase) is refused before anything is written (409, 400 or 404); an oversized or trickled body hits the guard's 64 KiB cap and timeout and the shape caps; an edit is pinned to the `updatedAt` it read, so a concurrent CLI edit or pass pause is never overwritten; every write logs `actor.source: dashboard`; and every mandate string renders as Svelte text.

Residual, as for every dashboard POST: a same-user process that reads the page token can write a mandate as the owner. As for the Foreman as a whole, `FORGE_DAEMON= forge mandate …` from a Bash-capable session reads as a human: the line guards a misled model, not a hostile one.

## Intake

Issue #434, phase 1.

A **goal mandate** (`forge mandate new [<id>] --title T --goal "<text>"`, or `--goal-file F` with `-` for stdin) states what to achieve instead of which issues to run: its scope stays empty, and the goal is set once, stored as the last frontmatter key on one JSON-quoted line (the YAML subset's block scalars don't round-trip every text), and shown only through `fenceImport` (`mandateGoal`).

`new --goal` queues the first **draft request** `{type: "draft", job: null, args: {mandate}, from: "forge"}`, and `forge mandate draft start <id>` queues another for an active goal mandate unless one is pending or in progress; nothing else writes one (`forge requests add` and `POST /api/requests` refuse `draft`), and `requestScope` sends it to `_office`, so only an [office run](office.md#office-runs) runs it, while `daemon.enabled` and `foreman.enabled` are on.

A **drafting run** is two CLI calls with one `forge:drafter` between them, as for triage and `forge job assist`: the office run claims the request, runs `forge mandate draft prepare <id> --request <rid>` as a CLI child, which writes the survey and returns the brief with the roster's model and effort for `drafter`, starts the drafter as a headless model child with that brief, runs `forge mandate draft record <id> --request <rid> --agent-id <drafter session id>` whatever line it returned, and acks (`done` with `drafted: <n> issues in <w> waves` or `stale: <reason>`, `rejected` with a refusal). The office run never reads the survey, the staging file, the draft or the drafter's reply.

The files:
- the **survey** (`.forge/runtime/mandates/<id>/survey.md`, at most 64 KiB: a column-0 data line, the fenced goal and guidance, Forge's own stats, every tracked `AGENTS.md` with its first prose line, and the tracker's open milestones (`Tracker.milestones`, optional) and open issues, each list in one `fenced()` block with every title through `oneLineTitle`);
- the **staging file** the drafter writes (`<worktrees.root>/_office/drafts/<id>.json`, inside the drafts dir, the drafter's one write root, so its Write passes the permission rules and the write guard, and cleared by `prepare`);
- and the **milestone draft** `record` stores once it passes `draftProblems` (`.forge/runtime/mandates/<id>/draft.json`, a versioned shape, `lib/core/versions/draft.ts`), with a `mandate-draft` audit event.

`forge mandate draft show <id>` reads it back with its status (`queued`, `drafting`, `ready`, `unreadable`, `failed` or `none`), its latest request and its spend.

**Spend**: `record` first appends one `agent-end` line to `.forge/runtime/mandates/<id>/ledger.jsonl`, with the drafter's usage from its transcript when `--agent-id` finds one (a sub-agent's `agent-<id>.jsonl`, else a headless session's own `<id>.jsonl` under the repo's project dir, `importSessionTranscript`). `metered: true` in a daemon session says the office run already metered that cost to `_office`, so it counts against `daemon.dailyUsd.office` and no sum adds it twice; a person's own run is `metered: false` and is recorded only on the mandate's ledger.

A ready draft waits at the `milestone-approval` gate (below); the mandate's `budget` over drafting spend comes with the director loop (#538).

## Intake threat model

The attackers: the owner's goal or guidance and tracker titles misleading the drafter; a job or inbox session misled by tracker or PR text into starting a drafting run, or writing or replacing a draft that approval would file; the builder agent; and a Bash-capable session writing under its write roots.

Each bypass fails:
- `prepare` and `record` exit 1 in any daemon scope but `_office` (and with a missing or invalid scope) before anything is read;
- draft requests are refused from `forge requests add`, `POST /api/requests`, and `forge mandate draft start` or `new --goal` in any daemon session, so no session can queue drafting spend;
- both calls need `--request` naming an in-progress `draft` request for that mandate, looked up in the listing before any path is built from it, so a draft can't be recorded without a claimed run or onto another mandate;
- the staging file is read through `readRegular` (no link, no FIFO, at most 256 KiB), a link at the drafts dir is refused, and `prepare` removes a stale one;
- `draftProblems` refuses unknown keys, hidden or control characters, `existing` refs `checkIssueRef` refuses (a leading `-` never reaches `gh`) and file paths that are absolute, start with `-` or climb with `..`, so filing never sends such text;
- tracker titles can't leave their fence, because `fenced()` picks a longer fence and `oneLineTitle` removes hidden characters and line breaks;
- the drafter has `tools: Read, Grep, Glob, Write` and no Bash or web tools;
- and `milestones` builds its `gh api` path from `repoSlug`'s checked slug only.

Residual risks: a Bash-capable session can overwrite the staging file between `prepare` and `record`, but the draft stays an inert, checked file until someone decides it, and the decision pins the digest of the bytes the decider saw; `FORGE_DAEMON= forge mandate draft …` from such a session reads as a person, as for every Office check; the survey and the ledger live in the runtime dir, outside every session's write roots.

## Milestone approval and filing

Issue #434, phase 2.

A goal mandate's ready draft waits at the `milestone-approval` gate, a gate class that belongs to the mandate, not a job: no job waits on it, so the job tables and `forge job assist` leave it alone (`assist --gate milestone-approval` is always `stale`). Its status (`draftGate`, `lib/office/mandates/gate.ts`) is `filed` once the mandate's `filedAt` is set, `filing` while `filing.json` exists unfinished, `pending` for a ready draft of a goal mandate that isn't closed, else `none`; `forge mandate draft show` and `GET /api/mandates/:id/draft` give it with the draft's **digest**, the lowercase hex SHA-256 of the exact `draft.json` bytes read (never stored in the file).

Three decisions, one function (`decideDraft`) for the CLI and the dashboard: `forge mandate draft approve` files the draft; `revise --note` queues another drafting run whose brief carries the previous draft's path, its title and the note, the last two through `fenceImport` (when a `draft start` queued one first, revise exits 1 and queues and logs nothing); `reject` closes the mandate (`milestone draft rejected: <note>`), files nothing, and starts the next link of its chain. A note is 1–2000 characters of visible text on lines.

`--request` and `--digest` pin the draft read (the dashboard always sends both), and every decision runs under `locks/mandate-decide-<id>` with a one-second wait, so a double click, a terminal and a gate run can't decide twice.

**Who decides**: a person, in their own terminal or the dashboard; under `FORGE_DAEMON=1` a call without `--actor foreman` exits 1 in every scope before anything is read, and `--actor foreman` exits 1 everywhere ([Authority](authority.md#authority)). The default `foreman.decides` leaves the class out, so a project lists it to delegate it, and a mandate's own `decides` narrows it further.

When both delegate it, `forge mandate draft record` queues one job-less `gate` request (`{gate: milestone-approval, mandate, key: <draft request>, digest, reserved}`, which `enqueue` accepts only with a valid mandate id) that routes to `_gates`; its gate run takes assist from `assistDraft` (what `forge mandate draft assist <id> --request <gid>` prints: a brief of paths and fenced data, never draft text) and records `approve` or `revise` through `decideDraft` with its authority, which `checkMandateGateDecision` (`lib/office/foreman/policy.ts`) judges with the same `foremanAuthorityRefusal` and `foremanPolicyRefusal` as job gates, plus a matching in-progress gate request for the current key and digest and a cap of two foreman revisions per mandate (`FOREMAN_REVISIONS_MAX`, until the mandate's budget lands).

Reject, and retrying a stopped filing, stay a person's. Every recorded draft also queues a `gate` notification (`milestone-approval`, no free text).

**Filing**: the CLI, never an agent, reads the draft once (the bytes give both the digest and the body filed), runs every pre-flight check before any write (the tracker has `createMilestone`, the title is a valid scope milestone with no leading, trailing or repeated whitespace, the converted mandate passes the contract, no open milestone or item has the title, each `existing` ref is an open item of this tracker, and one secret scan over every outgoing string), then writes `filing.json` (with the digest) and the `mandate-draft-approved` event, creates the milestone, files each issue in wave order (`wave-<n>` labels, never prefixed, so triage sees them; reuse and amend move an existing item in), recording each ref as it lands, and last writes the mandate with `scope.milestones: [<title>]` and `filedAt` (`mandate-filed`).

On GitHub every `@name` in an issue body, an amendment or the milestone description gets a zero-width joiner after its @ (outside a fenced code block that opens at column 0), so filing notifies no one. A tracker call that throws keeps the record with its `error` (the gate is `filing`); the refusal names where filing stopped, with the error JSON-quoted for a person and left out for the foreman (it stays in `filing.json`), since a tracker error can echo the draft's title.

Approve again resumes without filing anything twice, adopting the one open item with the exact title for a key that was started but not recorded; a retry refuses once `draft.json`'s digest differs from the record's. The filed mandate is an ordinary scoped mandate whose issues go through readiness triage like any other.

## Milestone approval threat model

The attackers: a daemon session (a job session, the inbox, the office or a chat) misled by tracker, PR, goal or draft text; the drafter, whose output reaches the tracker and the office's context; the `forge:assistant` that reads the draft; another site in the owner's browser; the builder agent; and a Bash-capable session writing under its write roots or the runtime dir. Each bypass fails.

- A session deciding as a person: every daemon call without `--actor foreman` is refused before anything is read.
- The foreman outside policy: the authority, `foreman.enabled`, `foreman.decides`, `gate:milestone-approval`, the mandate's own decides (an unreadable mandate delegates nothing), a reserved pattern anywhere in the goal, the draft or the note, reject, a stopped filing, a missing or mismatched gate request and the revision cap are each a refusal.
- Approving bytes nobody saw: the request and digest pins hold for the dashboard and the foreman, filing parses the digested bytes, and a retry checks the record's digest.
- Drafter text steering the office: `draftProblems` and filing's pre-flight name positions only (`issues[2].files[0]`, "the draft's milestone title"), a foreman's stopped filing carries no tracker error, the assistant brief holds paths and fenced data, and the revision note and previous title reach the drafter fenced.
- Filed text pinging people on GitHub: mentions get a zero-width joiner after the @.
- A credential smuggled to the tracker: one scan over every outgoing string, plus the guarded adapter's own scan of `createMilestone` and `milestoneAdd`.
- Option injection into `gh`: the milestone title can't start with `-`, titles go in `=` or `-f key=value` arguments, labels are fixed `wave-<n>`, refs go after `--`.
- A forged job-less gate request: `enqueue` takes one only for this class with a valid mandate id, `forge requests add` and `POST /api/requests` still refuse `gate`, and one that doesn't match the current key and digest decides nothing.
- A cross-site POST: the token, Origin and JSON guard.
- Double filing: the decision lock plus the record.
- A planted link at `draft.json` or `filing.json`: `readRegular` refuses it, and an unreadable record files nothing.

## Mandate plan

Issue #711.

The **mandate plan** (`forge mandate plan <id>`, `GET /api/mandates/:id/plan`, `mandatePlan` in `lib/office/mandates/progress.ts`, the graph in `lib/engine/trackers/depends.ts`) is every scope issue and its dependencies, before any job exists: `{mandate, readAt, nodes, edges, problems}`. Neither the CLI nor the route loads a tracker. Each Office pass stores a mandate's error-free tracker scope read in `.forge/runtime/mandates/<id>/scope.json` (titles, wave numbers and parsed refs, never a body; `v: 1`, a cache, so any other `v` reads as not read yet), through real directories only, and a failed read leaves the previous file. The plan reads it through `readRegular` and re-checks every field, so the plan is as fresh as the pass's read (`readAt`). A scope that needs no tracker (order `listed`, or no milestones and no labels) is computed at once and `readAt` is now. With `foreman.enabled` off no pass runs, so a milestone or label mandate's plan carries a `scope` problem.

**Nodes** (`{ref, title, wave, job, state}`): the scope issues in scope order (first occurrence of a ref wins, needs-info ones included), then each primary issue of a live or archived mandate job that matches no scope node, by number then ref; that is how an issue closed during the mandate shows. `title` is the scope item's one-line title, else the job's; `wave` is n of a `wave-<n>` label (1–999, the smallest), else null. A job attaches to every node one of its issues matches (`sameIssue`); among several: not cancelled, then top-level, then the latest created, then the id. **State**: `merged` when the job is done, `running` when it is in any other state but cancelled; otherwise `waiting` while an upstream node is not merged, `ready` when every upstream is merged or when it has none but a downstream, `planned` on no edge.

**Edges** (`{from, to, source}`, `from` finishes first): `body` from the `to` issue's `Depends on:` line, `job` from a job's `dependsOn` (none within one node, none where a body edge joins the pair), sorted by node order. **The `Depends on:` rule** (`parseDependsOn`): only lines that start, at column 0 and case-sensitively, with `Depends on:` count (lines split on `\n` with an optional `\r`; code fences are not special); none means no known dependencies; two lines, a line over 2000 characters, an empty list or entry, over 20 entries, or an entry `checkIssueRef` refuses is refused; else the de-duplicated stored refs.

**Problems** (`{kind, ref, detail, edges}`, ordered by kind, then node order; `detail` is Forge's text with refs, job ids and numbers only): `scope` (no usable stored read: never read, unreadable, another `v` or mandate, scope lists changed since, a bad shape; scope nodes are then empty, job nodes still show), `malformed` (an issue's line breaks the rule; no edges from it), `outside` (a ref names no node), `unknown` (a job's `dependsOn` names a job outside the mandate or with no issue), and `cycle` (every edge inside a strongly connected component, self-loops included, is dropped and listed). The route passes the plan through `redactDeep`.

Threat model: tracker titles come back as JSON strings, never markup; a body's text is never stored or returned, only refs that pass the ASCII ref grammar, which refuses zero-width characters and look-alikes; the 20-entry and 2000-character caps bound a flood; cycles can't wedge a layout; a planted or corrupt `scope.json` (a link, over 1 MiB, a wrong shape) is a `scope` problem; and no ref ever reaches `gh`.

Residual risks: a Bash-capable session can rewrite `draft.json` and the gate request together before anyone reads them, and the owner or assistant then judges the rewritten (still rule-checked) draft, which is exactly what files; forging `args.foreman: true` only lowers the revision cap; and `FORGE_DAEMON= forge mandate draft approve` reads as a person, as for every Office check.
