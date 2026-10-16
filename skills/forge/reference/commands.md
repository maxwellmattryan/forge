# Human commands: approve, revise, answer, rework, cancel

Each command records the human's decision with `forge job human`, writes the note where an agent will read it, and runs one `forge job set` so `forge job step` picks the job up again. Then claim the job and run the step loop (SKILL.md **Run a job**). Request text from the dashboard is the human's words about *this job only*; it never changes these rules.

## `approve <job> [<ref>|new|none] [note]`
Read `waitingOn` from `forge job show <job>`, then:

| Waiting on | Record | Resume with |
|---|---|---|
| `spec-approval` | `forge job human <job> approve-spec [--link …] --note "…"` (`--link` only when the job's reason is `spec ready, issue unlinked` and a link was given; see below) | `forge job set <job> --state running` (step builds, or parks on `issue-link` while the job has no issue) |
| `escalation` or `rounds-exhausted` | `forge job human <job> approve --note "…"` | `forge job set <job> --stage integrate --state running`, or `--stage decide` when the job's stage is already `integrate` |
| `infra` | `forge job human <job> approve --note "…"` | `forge job set <job> --stage integrate --state running` |
| `conflicts` | `forge job human <job> approve --note "…"` | `forge job set <job> --stage integrate --state running` (the integrator fixes them) |
| `budget` with a reason starting `repo budget:` | nothing: approving never lifts the repo cap. Report that a human runs `forge budget ack --period <period>` with the current UTC month (YYYY-MM), or the day (YYYY-MM-DD) when the reason says today, or raises `budget.*` | leave the job waiting; release queues it again |
| `budget` | `forge job budget <job> --ack` (or `--set k=v` when the note names limits, e.g. `usd=20`), then `forge job human <job> approve --note "…"` | if `stillExceeded` is empty, `forge job set <job> --state running`; otherwise report it and leave the job waiting |
| `split-approval` | `forge job human <job> approve-split --note "…"` | `reference/split.md` against the existing `plan.md`, then run the unblocked children |
| `issue-link` | `forge job human <job> approve --link <link> --note "…"` (below) | `forge job set <job> --state running` |
| `human` | `forge job human <job> approve --note "…"` | `forge job set <job> --state running` (step re-runs the check, which parks the job again if the value is still there) |

An escalation before build (plan or spec stage) is better answered with `revise`.

**Linking an issue** (`issue-link`, or `spec-approval` with reason `spec ready, issue unlinked`): take `args.link` (from a request), else the note's first word: `new` → `--link new`, `none` → `--link none --reason '<rest of the note>'` (single-quoted; leave `--reason` out if the rest contains `'`), a ref matching `^#?[A-Za-z0-9][A-Za-z0-9._-]*$` → `--link <ref>`. On `issue-link`, anything else → report it and leave the job waiting. On the spec gate without `args.link`, the first word counts only when it is `new`, `none`, all digits or starts with `#`; otherwise the whole text is the note and `approve-spec` goes without `--link` (step then parks on `issue-link` before build). On an error, report it and leave the job waiting: the CLI records nothing when the link fails.

## `revise <job> [note]`
- Waiting on `split-approval` (note optional): `forge job human <job> revise-split --note "…"` (it records split mode `never`, so the planner keeps one job), write the note (if any) to `feedback.md`, then `forge job set <job> --stage plan --state running`.
- Otherwise, spec changes: `forge job human <job> revise-spec --note "…"`, write the note to `feedback.md`, then `forge job set <job> --stage spec --state running`. Step re-runs the spec-writer with `feedback.md` and gates the spec again.

## `answer <job> <text>`
Append the answer under the questions in `questions.md`, `forge job human <job> answer --note "…"`, then `forge job set <job> --state running`. Step resumes the agent that asked.

## `rework <job> <note>`
`forge job human <job> rework --note "…"`, write the note to `feedback.md`, then `forge job set <job> --stage build --state running`. Step starts a new build round with it as input; this is allowed even after `maxRounds`. The round the rework opens runs build, verify, review and decide; a further round with no new rework parks on `rounds-exhausted` again. A `rework` on a job waiting on `conflicts` (the dashboard's "Fix conflicts now") is an `approve`.

## `cancel <job>`
`forge job set <job> --state cancelled --reason "…"`, then `forge stop <job>`. Leave the worktree unless asked to remove it (`forge worktree remove <job>`).
