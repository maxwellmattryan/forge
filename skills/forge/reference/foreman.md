# Foreman turns (office session)

`forge requests scope` said `scope: "office"`. You are the foreman: you decide parked gates through `forge:assistant` sub-agents and record their verdicts through the CLI. Keep your own context small: **never open, read, cat, grep or write any file in a job directory**, and never paste file text into a brief; never open the survey, the staging file or the draft of a drafting run either. Everything you need comes back as compact JSON from `forge`. Handle only `gate` and `draft` requests; never drive, claim or merge a job (`forge worktree create`, `forge job agent … start`, `forge job advance`, `forge job claim` and `forge pr merge` refuse here).

**Notes and reasons.** Wherever `<reason>` goes on a command line, pass it in double quotes with `"`, `` ` ``, `$`, `\` and newlines removed, at most 200 characters. One `forge` call per Bash call, as for every daemon turn.

## For each gate request
`{id, job, args: {gate, reserved, key?}}` from `forge requests`:
1. `forge requests claim <rid> --session ${CLAUDE_SESSION_ID}` (exit 3: skip it).
2. If `args.reserved` is set: `forge job handoff <job> --class reserved --reason "reserved: <pattern>"` (skip it for `release`; if it exits 1, carry on), then `forge requests ack <rid> --status rejected --result "reserved: <pattern>"`. Done.
3. `forge job assist <job> --gate <gate>`. Exit 1 (an unknown gate): ack `rejected` with the error. `stale: true` (the job no longer waits on that gate): ack `done` with `stale`. `reserved` set: handle it as in step 2.
4. Spawn one `forge:assistant` sub-agent with the returned `brief` as its whole prompt, and its `model` and `effort`.
5. Read its one line, `ASSIST: approve|revise|rework|escalate · <reason>`. A missing or malformed line counts as `escalate`.
6. On `escalate`: `forge job handoff <job> --class escalated --reason "<reason>"` (skip it for `release`; if it exits 1, carry on), then `forge requests ack <rid> --status rejected --result "escalated: <reason>"`. Otherwise run the gate's row below, then `forge requests add resume --job <job>` (not for `release`, which moves no job: a human or CI starts `forge release run`), then `forge requests ack <rid> --status done --result "<verdict>: <reason>"`.

| Gate | approve | revise | rework |
|---|---|---|---|
| spec-approval | `forge job human <job> approve-spec` | `forge job human <job> revise-spec` | = revise |
| split-approval | `forge job human <job> approve-split` | `forge job human <job> revise-split` | = revise |
| escalation, rounds-exhausted | `forge job human <job> approve` | `forge job human <job> revise-spec` | `forge job human <job> rework` |
| conflicts | `forge job human <job> approve` | = escalate | = approve |
| repo-proposal | `forge job human <job> approve-repos --repo <repos>` | `forge job human <job> reject-repos --repo <repos>` | = revise |
| pr-feedback | record nothing and queue no resume: ack `done` with `no action: <reason>` | = rework | `forge job human <job> rework` |
| release | `forge job human <job> approve-release --actor foreman --note "<reason>"`; queue no resume | = escalate | = escalate |

Every `forge job human` here carries `--actor foreman --note "<reason>"`. The job's own session moves it: the resume you queue in step 6 runs its step loop, which turns the recorded decision into the gate's follow-up. `<repos>` is the `repos` list from step 3's `forge job assist`, comma-joined: the same names as the brief's `Pending repos` line, never edited or taken from a job file. For `revise` and `rework` the assistant has already written `feedback.md`; don't touch it. If `forge job human` refuses (the job moved on, or the CLI's authority checks say no), queue no resume, and ack: `done` with `stale` when the job no longer waits on the gate; otherwise run `forge job handoff <job> --class refused --reason "<refusal>"` (skip it for `release`; if it exits 1, carry on), then ack `rejected` with the refusal. End the turn when every gate request is acked.

Two parks are a person's alone, and the CLI refuses every foreman action there: a `rounds-exhausted` park past the **total-round ceiling** (`pipeline.maxTotalRounds`, by default twice `maxRounds`; no gate request is queued for it), and a PR at the **CI rework cap** (`pr.maxCiReworks`; its reason starts `CI rework cap:` and no `pr-feedback` gate is queued for that head). Never work around either: leave the decision to a human.

## For each draft request
A drafting run turns a goal mandate's goal into its milestone draft. `{id, args: {mandate}}` from `forge requests`:
1. `forge requests claim <rid> --session ${CLAUDE_SESSION_ID}` (exit 3: skip it).
2. `forge mandate draft prepare <mandate> --request <rid>`. Exit 1: ack `rejected` with the error. `stale: true`: ack `done` with `stale: <reason>`.
3. Spawn one `forge:drafter` sub-agent with the returned `brief` as its whole prompt, and its `model` and `effort`. Keep the agent id the Agent tool returns.
4. Whatever line it returned (`DRAFT: written · <title>` or `DRAFT: failed · <reason>`), run `forge mandate draft record <mandate> --request <rid> --agent-id <agent id>`. It records the run's spend first, then checks and stores the draft.
5. Ack: on success `done` with `drafted: <n> issues in <w> waves` (`draft.issues` and `draft.waves` from step 4); on exit 1 `rejected` with the refusal cut to 200 characters. Queue no resume: a drafting run moves no job.
