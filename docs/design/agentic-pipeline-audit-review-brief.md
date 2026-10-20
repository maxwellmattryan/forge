# Review brief: Forge pipeline audit and Office/Foreman direction

Written 2026-10-19 for an independent reviewer. It summarises a session in which Claude researched the state of agentic coding / software factories, audited Forge against it, and then discussed with the maintainer how the Office / Foreman (GitHub issue forge#281) should be shaped. The full audit is `docs/design/agentic-pipeline-audit.md` (about 7,200 words, cited to code lines, 148 local jobs and external sources). This brief is the position reached by the end of the conversation, including the last exchanges that post-date the audit document.

Please review critically. The maintainer wants to know where the reasoning is weak, where the evidence is thin, and whether the recommended architecture is the right one.

## 1. What Forge is

Forge is a Claude Code plugin that runs a software factory: a request or tracker issue becomes a job in its own git worktree, walks a pipeline (plan → spec → spec-approval gate → design → build → verify → review panel → integrate → decide → PR), and ends as a reviewed pull request. Key facts about today's architecture:

- `lib/step.ts` is a pure, deterministic decider of the next pipeline action (about 94 rule ids). `forge job advance` runs it. The CLI is the only writer of state.
- Role agents (planner, spec-writer, designer, builder, reviewer per lens, approver, integrator, assistant, triage, verifier, retro, judge) are Claude Code sub-agents with one prompt each in `agents/`.
- `forge dash` runs a daemon pool of headless `claude -p` sessions. Three kinds of session (called lanes) all run the same `/forge requests` orchestrator skill, told apart by an env scope: `_inbox` (intake only: triage, claim, hand off), `_office` (the Foreman: fields gate requests by spawning an `assistant` sub-agent per gate and mapping its one-line verdict through a fixed table), and one session per job (relays `step()` output: spawns the role agent `step` asks for, imports its result, resumes).
- Authority is enforced in code (`lib/foreman.ts`): `--actor foreman` is accepted only from the office scope; reserved topics (`foreman.reserved`) stay with a human; `foreman.decides` lists the gates the Foreman may decide.
- Config is `.forge/config.yml`, 149 leaf keys in `defaults()`, documented in `docs/CONFIG.md` (953 lines).

## 2. Maintainer's original questions

1. Is the pipeline too thorough, burning tokens for a slightly better result? Review panels seem high value. Should planning and spec-writing be one step?
2. What is the inbox, how does it relate to the office, why is the inbox daemon separate from the foreman daemon, and is the office too much overhead such that one orchestrator (the Foreman) should direct jobs?
3. Is config.yml too big, and how should it shrink while fitting many repo shapes?

## 3. Audit findings (measured over 148 local jobs, about $1,888 of agent spend at API list prices)

**Pipeline cost shares.** Build round 1 40.4%, review 23.0%, rework builds 17.0%, spec 11.0%, approver 4.0%, planner 2.7%, integrator 1.7%. Orchestrator sessions are not in `forge stats`; daemon logs put them at roughly 10 to 12% on top (a floor; the range across counting methods is 6 to 40%).

**Planner.** 109 runs, 104 SINGLE / 5 SPLIT. Its only pipeline-changing output is the split verdict. 95 of 104 specs copy the plan's phases. Recommendation: fold the planner into the spec-writer (verdict in the spec header; split gate at the spec stage).

**Spec gate.** 128 approve / 4 revise; most approvals by a Claude stand-in rather than a person, and `human` events do not record which. Recommendation: gate only large or rule-flagged specs by default; add an actor kind to the event.

**Review panel.** Keep it. Security lens: 8 of 10 blockers ever written, forced 33 rounds alone. Docs, design, tests, ui, ux: 0 blockers in hundreds of reviews. Rounds 2+ panels pass 80 of 97 times. Recommendation: per-lens non-blocking flag (docs, design); rework rounds re-run only CHANGES lenses plus `always` lenses on the diff since the last round; `maxRounds: 2`.

**Approver.** 77 APPROVE / 56 ESCALATE; 47 of 50 escalated jobs later approved as-is; about 40 of 56 reasons are facts the CLI already has (protected path, runbook present, failing acceptance checks, reviewer ESCALATE summary, manifest change). Recommendation: a deterministic `forge job gate` before the approver; approver only for the residue.

**Inbox / Office / per-job sessions.** All three are one prompt in three lanes. The inbox session did 18 turns in a week, one non-triage agent ever. The Office decided 0 of 22 gates (6 stale, 12 escalated on reserved topics, 4 handled by the maintainer's interactive session). Per-job sessions cost about $218 of thread-only spend and roughly 10 minutes per job in hand-off gaps, while `step()` makes every decision. Stated reasons for separation (blast radius, provenance, context isolation, cap bookkeeping) are all properties of the pool and the CLI, not of having three conversations. Recommendation: inbox → pool code plus a one-shot triage child; office → pool spawns the assistant directly (`forge job assist --apply`); eventually the pool loops `step()` and spawns role agents headless, with `/forge` kept for humans at a terminal.

**Config.** 149 leaf keys, documented keys up 73% in seven days, 10 keys never read, this repo's file writes 72 keys at default, multi-service machinery (about 45 sub-keys) exercised by no real job. Recommendation: init writes deltas only; `extends:` presets; list-append form; one cleanup migration; keep about 36 structured keys, derive 24, preset 45, prose 10, delete 14. 266 lines → about 35 here; 6 to 10 for a typical web app.

**Caveats the audit states.** No A/B eval of any pipeline variant has ever been run. Dollars are list-price equivalents. No published study ablates a frontier-model role pipeline on real repos, so Forge's own `forge stats` and `forge eval start --set` overlays are the decisive instrument.

**External evidence relied on (summarised).** arXiv 2512.08296 (260 configurations: every multi-agent arrangement loses 2 to 15% on SWE-bench Verified vs a single agent at 1.6 to 6x turns); Anthropic "Building effective agents" (workflows first) and multi-agent research post (coding parallelises poorly, about 15x tokens); Cognition "Don't build multi-agents" and its 2026 follow-up (writes stay single-threaded); 12-factor agents (own your control flow, stateless reducer); Ralph loop (fresh context per iteration, code restarts it); Anthropic auto-mode data (humans reject 39% of plans vs 3% of permission prompts; vigilance decays); arXiv 2604.10508 (two repair rounds capture 76 to 95% of achievable gain); Anthropic code-review post (59% of re-flagged code unchanged; diff-only re-review; cap at 3 rounds); SWR-Bench (merged independent reviews +44% F1), MARS (personas add nothing); Watson Labs 12k reviews (same finding seven times without exclusion lists; pass/warn/fail); Renovate/ESLint/Nx/Prettier/Google SRE config philosophy. Vendor claims are marked as such in the full audit.

**Prioritised list (from the audit).** 1 instrument orchestrator spend and actor kind; 2 diff-scoped rework rounds, maxRounds 2; 3 non-blocking docs/design lenses; 4 deterministic `forge job gate`; 5 inbox → pool code; 6 commit the six untracked eval tasks and run three A/Bs before changing defaults; 7 fold planner into spec-writer; 8 specApproval large by default; 9 a security verifier for recurring hole families; 10 office → pool-run assistant; 11 config shrink; 12 per-job sessions → pool loops `step()`.

## 4. The exchanges after the audit (the part to review most carefully)

### 4a. Maintainer's position

"A Foreman spawning an assistant per job makes the most sense. The assistant decides on the gates itself or escalates to the Foreman. This lets the Foreman save context so it can go for longer." Then: "I want to get waves of work done. Features will be a whole milestone or multiple milestones of issues, so the Foreman needs to stay alive until all of those GitHub issues are completed. So assistant foremen make a lot of sense." And: "Each job already has an orchestration session. Can't we use that to decide gates or give recommendations, or would a per-gate assistant assess better?"

### 4b. Claude's response

**Per-job session deciding gates: no.** (a) It is the party being gated; `lib/foreman.ts` deliberately blocks a job session from acting as foreman, and daemon logs show Claude's safety classifier refusing self-approval attempts. (b) Its context is relay noise by the time a gate opens; a fresh assistant with a brief pointing at spec.md, review files and the escalation reason is cleaner and cheaper (clean-context reviewer evidence). (c) If the per-job LLM session is eventually replaced by the pool looping `step()`, there is no session to ask anyway. So a fresh assistant per gate is the better assessor, and writing the recommendation belongs to it too.

**Per-job assistant vs per-gate assistant: per gate.** A session persisting across a job's gates is exactly the per-job orchestrator lane measured as about 10% of spend plus hand-off latency. The brief already gives a fresh assistant the same job files.

**Escalating to the Foreman rather than a human: adds a hop.** All 12 real escalations on this repo were on reserved topics (credentials, publishing authority, security posture), which exist because a human must decide. An LLM Foreman cannot resolve them either. Human signal is highest at spec/escalation gates (39% plan rejection), so those gates should not be automated away.

**"Stay alive for a milestone": agree with the goal, disagree that it means a resident conversation.** What must persist is the mandate and state (issues, order, what merged, decisions and reasons), not the transcript. A conversation open for a multi-milestone wave is the one design guaranteed to hit the context wall, however much it delegates. Proposed shape:

- The pool (a process) is what stays alive: slots, strikes, budgets, request queue; no context to exhaust.
- The Foreman is a one-shot wake with a mandate: `.forge/mandates/<wave>.md` holds milestone, issue list, dependency order, standing guidance. The pool wakes the Foreman on events (job merged, slot freed, inbox empty, assistant escalating on a mandate question) plus a cadence fallback. Each wake is a fresh headless run that reads the mandate, a compact board survey and its own prior directives, emits decisions through CLI commands, and ends. A wave can therefore run for a week.
- Assistant foremen are per milestone in name, per gate in execution: one fresh assistant run per gate, reading the mandate plus the job files, deciding what the mandate permits, escalating the rest to a Foreman wake or to the human.
- The maintainer keeps a conversational view: the dashboard Thread shows the Foreman's wakes as one timeline, and the maintainer's own interactive session can still act as foreman via the same CLI, able to hand off at any point because state lives in the mandate file.

This is forge#281 with one correction: the director is stateless between wakes.

### 4c. Proposed edits to forge#281 ("Office: the Foreman directs work through mandates, assistant foremen take gates")

#281 already has: mandates as CLI-written files with frontmatter (scope, until, maxJobs, order) and an owner-text body fenced as data; a Foreman that never decides gates, reads job files or merges; cadence plus event wakes; one-line directives; CLI still enforcing `foreman.decides` / `reserved` / `ship`; an Office dashboard page; four phases, one PR each.

Edits proposed:

1. **Fresh per wake, not a resumed session.** Replace item 2's resident `_office` session and item 4's surveyor sub-agents with: every wake is a new headless run, no resume; it reads mandates, a deterministic `forge mandate survey` JSON and prior directives. Acceptance line becomes "CLI JSON and directives only".
2. **No assistant foreman sessions.** Replace item 3's pooled assistant foreman sessions (`foreman.assistants`) with the pool spawning the assistant directly, one fresh run per gate, through `forge job assist --apply` that parses the verdict and calls the same authority checks. "Assistant foreman" may remain as the name of a per-gate run.
3. **The assistant reads the mandate.** Add the active mandate body, fenced as owner text, to the assistant brief so it can apply standing guidance to gates without waking anything.
4. **Trim config.** Keep `foreman.{model, effort, cadence}`; drop `assistants` and `surveyors`.
5. **Add escalation drafts.** When the assistant escalates a reserved gate, it writes a short recommendation shown first on the Needs-you card; stats record the human override rate, which later tells whether a gate class can move into `foreman.decides`.

Leave alone: the out-of-scope line (what the gates are and who decides them stays in the CLI) and the four phases (phase 2 becomes "gates spawn the assistant directly", phase 3 "the director wake"). Note on the issue: once the director queues `next` and `resume`, the inbox session is redundant, so inbox → pool code can land with or just before phase 3.

The maintainer has not yet approved these edits; nothing has been written to the issue.

## 5. Questions for the reviewer

1. Is the "stateless Foreman, fresh per wake" conclusion sound, or does a resident Foreman session with surveyors (as #281 currently says) have advantages the audit undervalues (continuity of judgement, cheaper per-wake cost through cache, fewer re-reads of the mandate)?
2. Is per-gate fresh assistant really better than a per-job assistant that keeps the job's context? What evidence would settle it?
3. Does the escalation ladder (rule → assistant → Foreman wake → human) make sense, or should the assistant escalate straight to the human for anything the mandate does not cover?
4. Is the audit's reading of the measured data fair? In particular: treating the per-job orchestrator sessions as "pure relay" and recommending the pool loop `step()` itself, and treating the 0-of-22 Office decisions as evidence against the Office lane rather than as a policy artefact of `foreman.reserved`.
5. Anything in the prioritised list that is mis-ordered, or a recommendation the cited evidence does not actually support?
