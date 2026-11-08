# Foreman: releases

Part of [Foreman](../foreman.md).

## The release gate class

Code: lib/engine/release/approval.ts.

No job waits on a release, so `release` is routed from the plan, not a park: `forge release plan --job <id>` logs `release-planned {planHash}` (the full sha256, unless the job's latest one already has it) and, when the foreman decides `release`, enqueues one `gate` request `{job, args: {gate: "release", key: <planHash>, reserved}}`, unless one for that job and key exists in any status, so a gate left for a human is never re-armed for the same plan. "Decides" means `foreman.enabled`, `release` in `foreman.decides`, and no `gate:release` in `foreman.reserved`, which the defaults keep: `decides()` drops every class reserved with `gate:<class>`, so reserved wins for every gate and caller, and a `gate:` entry naming no class makes `reservedMatch` fail closed.

`forge job assist <job> --gate release` is `stale` unless release.json selects the job, its latest `release-planned` is release.json's hash and that hash has no approval; its brief names release.md, config.yml (`release`, `repos[].release`) and the job's request, spec and decision paths, plus `Release plan: <path> (plan <hash12>)`.

A gate run's `approve-release` (`recordForemanDecision`, through `checkReleaseDecision`) checks, before any write: the runner's authority; a note and no `--link`, `--reason` or `--repo`; the policy (each refusal names enabled, decides or `gate:release`); a readable release.json selecting this job; `freshPlan` recomputed from config and the clones matching it; the job's latest `release-planned` being that hash; a pending or in-progress `release` gate request keyed by it; no approval for it yet; and `reservedFor` over the job's reason and the note, which also refuses a latest security review that isn't PASS. It then logs one `release-approval {planHash, note, actor}` event and nothing else: no `human` event, no state change, no resume and no `SET_AFTER` entry.

`forge job human <job> approve-release` is refused everywhere, with or without `--actor foreman`: a person approves at `forge release run`'s prompt. `forge release run` without a terminal passes a publish step only when the job has a foreman `release-approval` whose `planHash` is the plan it just recomputed, the foreman still decides `release`, the job's mandate (if it is in one) still delegates `release` and is neither paused nor closed (`releaseMandateRefusal`, read again at run time), and `reservedFor` over the job and the approval's note is null; the result carries `approvedBy: "foreman"`.

`forge release status`'s `approval` follows the same rule: once the approval stops counting it reports `{owner: 'human', status: 'pending'}`. A terminal always asks, a manual step still needs one, and the run itself stays refused in every daemon session, so a human or CI starts it.

## Release gate threat model

The attackers are a gate run's `forge:assistant` misled by text in release.md, the config or a tracker; a job, inbox, office or chat session posing as the foreman; and a Bash-capable agent writing `events.jsonl`, `release.json` or the request inbox directly. The authority check and the reserved note and security checks stop the first two; a forged or reused request fails the key match against the recomputed plan; an edited or stale release.json fails `freshPlan`; an approval for another plan or by another actor is ignored at run time, and so is one left over after the owner takes the class back or narrows, pauses or closes the job's mandate, because the policy and the mandate are re-read every time.

Residual risk: in a repo that delegated `release`, a process that can append to the job's `events.jsonl` can stand in for the foreman's approval of the current plan. It still can't change what runs (commands come from config and the recomputed plan), and no daemon session can start the run; in a repo that did not delegate, a forged approval does nothing.

## A mandate's release

Code: lib/engine/release/mandate.ts.

An `until: released` mandate (effective only under `foreman.ship: release`) is the one subject of the `release` class that isn't a job. When the Office pass would close it, it plans `{kind: 'since', tag, mandate, heads}` instead, `tag` being the root repo's latest tag reachable from HEAD (`git describe --tags --abbrev=0 HEAD` through the pinned git runner, then `assertSafeRef`) and `heads` each planned repo's HEAD commit by label, which the planner reads again on every recompute (`keptHeads` keeps a repo's planned head once a step that acts has run there under that plan's state.json); `planHash` covers `selection.mandate` and `heads`, so the plan is the mandate's and no plain `--since` plan's, and a commit that lands after the plan, or after its approval, makes it stale.

Its records go to the repo audit log, outside every session's write roots: `mandate-release-planned {mandate, planHash, tag, actor}`, `mandate-release-approved {mandate, planHash, note, actor: foreman}` and `mandate-release-finished {mandate, planHash, actor}`, read back only when well formed (a mandate id, a 64-hex hash, a foreman actor for approvals).

The pass also logs a `release` directive, notifies `gate` with reason `mandate-release` (on the first plan and on one after a release ran, not on a re-plan of a plan that never ran), and queues one job-less gate request `{job: null, args: {gate: "release", mandate, key: <planHash>, reserved: null}}` when the Foreman decides `release` and `mandateReleaseRefusal` (lib/office/foreman/policy.ts) is null, at most one per mandate and hash in any status. `mandateReleaseRefusal` is the mandate's policy, in order: the file can't be read, it is closed, it is paused, its cut `decides` leaves `release` out, its effective `until` isn't `released`, or a reserved pattern matches its title or a title of one of its live or archived jobs.

Its gate run's assist (`assistMandateRelease`, what `forge mandate release assist <id> --request <rid>` shows a person, refused in every daemon session) is `stale` unless the mandate's release state is `pending` and its latest planned hash is the request's key; its brief names release.md, config.yml (`release`, `repos[].release`), `Release plan: <path> (plan <hash12>)`, the mandate's done jobs as `Mandate jobs (JSON): [{job, pr, repos}]` (no titles) and the guidance fenced.

On an `approve` verdict the gate runner records the approval through `approveMandateRelease`, which checks, before its one write: the runner's ForemanAuthority; a note; the policy (enabled, `release` in `foreman.decides`, no `gate:release`); `mandateReleaseRefusal`; a readable release.json selecting this mandate; `freshPlan`; the mandate's latest planned hash being that plan's; a pending or in-progress gate request for it; no approval yet; and no reserved pattern in the note. `forge mandate release approve <id> --actor foreman` reaches the same checks and so is refused in every scope; without `--actor foreman` it is refused before anything is read.

A `revise` or `rework` verdict escalates, which leaves the plan for a person at `forge release run`. `forge release run` and `forge release status` take `mandateNarrow` from the CLI and count a foreman approval of a mandate plan only through `mandateReleaseApproval`, which asks `mandateReleaseRefusal` again; without it they count none (fail closed).

`forge release plan --mandate <id>` re-plans after the pass planned once, or makes the first plan while `otherReleasePlan` finds release.json holding a plan the pass won't write over (one it can't read, or another plan whose run hasn't finished), for an active mandate whose effective `until` is `released`, and is refused in every daemon session.

The pass closes the mandate when its latest plan has a `mandate-release-finished` event or a finished state.json and no mandate job (live or archived, done) merged after that plan's `mandate-release-planned` event (its PRs' latest `mergedAt`, else its latest transition to `done`); a later merge makes the finished plan `stale`. Otherwise it waits with `blocked: release: <detail>` and no budget pause, cadence stall or `direct` request.

It plans only an unplanned mandate or a stale plan with no run of it in progress, and `planMandateRelease` with `byPass` refuses when release.json holds a plan that isn't this mandate's and whose run hasn't started (`blocked by another plan, plan it with forge release plan --mandate <id>`), so it never overwrites another plan or a started run. A stale plan whose run has started says `…; re-plan with forge release plan --mandate <id> --force`, and `freshPlan`'s refusal of a stale mandate plan names the same re-plan rather than a plain `forge release plan`, which would replace the mandate's plan.

## Mandate release threat model

The attackers are an agent session (a job session, or the office or a gate run's assistant misled by tracker or PR text) and a hostile checkout; they want a publish without approval, or to re-arm or reuse an approval. The defences:
- A planted or edited release.json fails `freshPlan`, its hash covers the mandate and the planned heads, and `readPlanFile` refuses a `selection.mandate` that isn't a mandate id or `selection.heads` that aren't commit ids;
- a merge after the approval changes a head, so the approval never stands for code it didn't see;
- only the gate runner's in-process authority records an approval, and no `forge` command can;
- `--mandate` is refused in every daemon session and requests are once per mandate and hash in any status, so no session re-arms a gate;
- the policy is asked again at approval, run and status, so narrowing, pausing, closing or lowering `ship` ends an approval;
- an approval is matched by mandate and hash, so it never stands for another mandate's plan or a plain `--since` plan;
- the pass only plans, and `refuseRun` keeps every daemon session from running;
- and the tag reaches git argv only after `assertSafeRef`.

Residual risk: in a repo that delegated `release`, a process that can append to `.forge/runtime/audit.jsonl` can stand in for the foreman's approval of the current plan, as for a job's `events.jsonl`; it still can't change what runs, and no daemon session can start the run. The same writer can mark an acting step started in state.json so a recompute keeps that repo's planned head; it gains nothing it couldn't get by forging the approval.
