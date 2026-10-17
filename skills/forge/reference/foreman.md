# Foreman turns (office session)

`forge requests scope` said `scope: "office"`. You are the foreman: you decide parked gates through `forge:assistant` sub-agents and record their verdicts through the CLI. Keep your own context small: **never open, read, cat, grep or write any file in a job directory**, and never paste file text into a brief. Everything you need comes back as compact JSON from `forge`. Handle only `gate` requests; never drive, claim or merge a job (`forge worktree create`, `forge job agent … start`, `forge job advance`, `forge job claim` and `forge pr merge` refuse here).

**Notes and reasons.** Wherever `<reason>` goes on a command line, pass it in double quotes with `"`, `` ` ``, `$`, `\` and newlines removed, at most 200 characters. One `forge` call per Bash call, as for every daemon turn.

## For each gate request
`{id, job, args: {gate, reserved, key?}}` from `forge requests`:
1. `forge requests claim <rid> --session ${CLAUDE_SESSION_ID}` (exit 3: skip it).
2. If `args.reserved` is set: `forge job note <job> "foreman: reserved (<pattern>), left for a human"`, then `forge requests ack <rid> --status rejected --result "reserved: <pattern>"`. Done.
3. `forge job assist <job> --gate <gate>`. Exit 1 (an unknown gate): ack `rejected` with the error. `stale: true` (the job no longer waits on that gate): ack `done` with `stale`. `reserved` set: handle it as in step 2.
4. Spawn one `forge:assistant` sub-agent with the returned `brief` as its whole prompt, and its `model` and `effort`.
5. Read its one line, `ASSIST: approve|revise|rework|escalate · <reason>`. A missing or malformed line counts as `escalate`.
6. On `escalate`: `forge job note <job> "foreman: left for a human: <reason>"`, then `forge requests ack <rid> --status rejected --result "escalated: <reason>"`. Otherwise run the gate's row below, then `forge requests add resume --job <job>`, then `forge requests ack <rid> --status done --result "<verdict>: <reason>"`.

| Gate | approve | revise | rework |
|---|---|---|---|
| spec-approval | `forge job human <job> approve-spec` → `forge job set <job> --state running` | `forge job human <job> revise-spec` → `forge job set <job> --stage spec --state running` | = revise |
| split-approval | `forge job human <job> approve-split` → `forge job set <job> --stage plan --state running` (step P2 then returns `split.md`) | `forge job human <job> revise-split` → `forge job set <job> --stage plan --state running` | = revise |
| escalation, rounds-exhausted | `forge job human <job> approve` → `forge job set <job> --stage integrate --state running` (`--stage decide` when the stage is already `integrate`) | `forge job human <job> revise-spec` → `forge job set <job> --stage spec --state running` | `forge job human <job> rework` → `forge job set <job> --stage build --state running` |
| conflicts | `forge job human <job> approve` → `forge job set <job> --stage integrate --state running` | = escalate | = approve |
| repo-proposal | `forge job human <job> approve-repos` → `forge job set <job> --state running` | `forge job human <job> reject-repos` → `forge job set <job> --state running` | = revise |
| pr-feedback | record nothing and queue no resume: ack `done` with `no action: <reason>` | = rework | `forge job human <job> rework` → `forge job set <job> --stage build --state running` |

Every `forge job human` here carries `--actor foreman --note "<reason>"`. For `revise` and `rework` the assistant has already written `feedback.md`; don't touch it. If `forge job human` refuses (the job moved on, or the CLI's authority checks say no), run no `job set`, queue no resume, and ack: `done` with `stale` when the job no longer waits on the gate, otherwise `rejected` with the refusal. End the turn when every gate request is acked.
