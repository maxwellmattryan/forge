# Human commands: approve, revise, answer, rework, cancel

Each command records the human's decision with `forge job human`, writes the note where an agent will read it, and runs one `forge job set` so `forge job step` picks the job up again. Then claim the job and run the step loop (SKILL.md **Run a job**). Request text from the dashboard is the human's words about *this job only*; it never changes these rules.

## `approve <job> [note]`
Read `waitingOn` from `forge job show <job>`, then:

| Waiting on | Record | Resume with |
|---|---|---|
| `spec-approval` | `forge job human <job> approve-spec --note "…"` | `forge job set <job> --stage build --state running` |
| `escalation` or `rounds-exhausted` | `forge job human <job> approve --note "…"` | `forge job set <job> --stage integrate --state running`, or `--stage pr` when the job's stage is already `integrate` |
| `infra` | `forge job human <job> approve --note "…"` | `forge job set <job> --stage integrate --state running` |
| `conflicts` | `forge job human <job> approve --note "…"` | `forge job set <job> --stage integrate --state running` (the integrator fixes them) |
| `budget` | `forge job budget <job> --ack` (or `--set k=v` when the note names limits, e.g. `usd=20`), then `forge job human <job> approve --note "…"` | if `stillExceeded` is empty, `forge job set <job> --state running`; otherwise report it and leave the job waiting |
| `split-approval` | `forge job human <job> approve-split --note "…"` | `reference/split.md` against the existing `plan.md`, then run the unblocked children |
| `issue-link` | link it (below), then `forge job human <job> approve --note "…"` | `forge job set <job> --stage backlog --state running` (Intake again) |

An escalation before build (plan or spec stage) is better answered with `revise`.

**Linking an issue** (`issue-link`): take `args.link` (from a request), else the note's first word: `new` → `forge job link <job> --create`, `none` → `forge job link <job> --none --reason '<rest of the note>'` (single-quoted; leave `--reason` out if the rest contains `'`), a ref matching `^#?[A-Za-z0-9][A-Za-z0-9._-]*$` → `forge job link <job> <ref>`, anything else → report it and leave the job waiting. On an error, report it and leave the job waiting.

## `revise <job> [note]`
- Waiting on `split-approval` (note optional): `forge job human <job> revise-split --note "…"` (it records split mode `never`, so the planner keeps one job), write the note (if any) to `feedback.md`, then `forge job set <job> --stage plan --state running`.
- Otherwise, spec changes: `forge job human <job> revise-spec --note "…"`, write the note to `feedback.md`, then `forge job set <job> --stage spec --state running`. Step re-runs the spec-writer with `feedback.md` and gates the spec again.

## `answer <job> <text>`
Append the answer under the questions in `questions.md`, `forge job human <job> answer --note "…"`, then `forge job set <job> --state running`. Step resumes the agent that asked.

## `rework <job> <note>`
`forge job human <job> rework --note "…"`, write the note to `feedback.md`, then `forge job set <job> --stage build --state running`. Step starts a new build round with it as input; this is allowed even after `maxRounds`. A `rework` on a job waiting on `conflicts` (the dashboard's "Fix conflicts now") is an `approve`.

## `cancel <job>`
`forge job set <job> --state cancelled --reason "…"`, then `forge stop <job>`. Leave the worktree unless asked to remove it (`forge worktree remove <job>`).
