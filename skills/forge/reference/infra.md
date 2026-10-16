# Services, infrastructure and work outside the repo

## Monorepos and multi-component repos
`config.components` lists the repo's parts: `{ name, path, kind: library | service | app, commands: { build, test, dev, … }, dependsOn: [{ component | backing, type: build | runtime }], owners, notes }` (docs/CONFIG.md "Components"). The spec-writer names the components a job touches in the spec's `Services:` header. Set them on the job (`forge job set <id> --field 'services=["api"]'`). When a job touches exactly one component of this repo, `forge run`/`forge verify` use that component's commands, run from its path. When it touches several, the top-level commands run, so make sure they cover everything.

A change that spans components should usually be split by the planner into per-component jobs with explicit ordering (e.g. backwards-compatible API first, then the client). A `build` dependency says which comes first.

## Infrastructure policy (`infra.mode`)
| Mode | Agents may | Agents may not |
|---|---|---|
| `human` (default) | edit IaC/config files in the repo, write `runbook.md` | run any cloud/cluster CLI that reads or writes remote state |
| `plan-only` | the above plus the read-only/plan commands listed in `infra.allowed` (e.g. `terraform plan`, `kubectl get`) | apply, deploy, delete, create credentials |
| `agent` | the above plus the mutating commands listed in `infra.allowed` | anything not listed; every such job still escalates to a human |

`forge job step` puts `infra.mode` and `infra.allowed` in the builder and approver briefs. Never run a cloud CLI yourself on Forge's behalf.

## Runbooks
Whenever a human must act, the builder writes `runbook.md` in the job dir:
```
# Runbook: <job title>
When: before merge | after merge | before deploy
Requires: <access/roles the human needs>
## Steps
1. <exact command or console path>. Expected: <what you should see>
## Verify
- <how to confirm it worked>
## Rollback
- <how to undo>
```
**Before-merge** steps: after an `APPROVE`, step sees the runbook's `When: before merge` line and parks the job on `infra` (`--reason "runbook: steps before merge"`); its `tell` names the runbook path. The human runs `/forge continue <id>` or `/forge approve <id>` (or presses "Steps done" in the dashboard) to resume at Integrate, which opens the PR at once when the branch is still up to date.
**After-merge** steps: proceed to the PR. The PR body (`pr.md`) links the runbook, and the final report repeats it.

## Work in other repos or teams
The planner lists it under **External**. Put it in the runbook's External section and the report. If the other repo also runs Forge, offer to create an issue there (`gh issue create -R <owner/repo> …`). Ask first, since that's outward-facing. If this job truly can't proceed without it, use `--state waiting --waiting-on external`.
