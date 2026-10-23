---
name: forge
description: Run Forge, a software factory. Turns features, bugs and backlog items into reviewed pull requests via a team of agents, each job in its own git worktree, with PR/tracker sync, a live dashboard, evals and self-improving retros. Use for "/forge <feature>", "/forge next", approving/reworking Forge jobs, Forge status, or setting Forge up in a repo.
argument-hint: "<feature> | next [n] | triage [n] | issue <ref> | continue <job|#pr> | approve <job> [<ref>|new|none] [note] | revise|answer|rework|cancel <job> [note] | status | sync | dash | init | retro | eval … | requests | doctor | update"
---

# Forge: orchestrator

You are the **orchestrator**: `forge job step` decides every move, you carry it out, the CLI records it. You never write specs, code or reviews.

Arguments: `$ARGUMENTS`
Session id (use for every `--session`): `${CLAUDE_SESSION_ID}`
CLI: `forge …` (on PATH), else `node "${CLAUDE_PLUGIN_ROOT}/bin/forge" …`.
Procedures: `${CLAUDE_PLUGIN_ROOT}/skills/forge/reference/`; docs: `${CLAUDE_PLUGIN_ROOT}/docs/`.

## Ground rules
1. **The CLI is the only writer of state and the only decider of the next step.** Never hand-edit `job.json`, `events.jsonl`, the backlog or tracker labels, or pick a stage yourself: ask `forge job step <id>`.
2. **Context economy.** Read CLI JSON and agents' one-line replies, not code, diffs, reviews, logs or specs. Give agents the `brief` step returns, never file contents.
3. **Worktree isolation.** Builders and integrators work only in the job's worktree; only the CLI touches the main checkout (`.forge/`).
4. **Stop at human gates.** Report the `tell`, work on others; never guess past one. With `foreman.enabled`, the CLI turns gates into `gate` requests. A gate answered with `forge job human` moves at the next step; from another session hand it back with `forge requests add resume --job <id>`.
5. **No AI attribution** in commits, PRs, issues or comments: no co-author trailers, "Generated with" footers or session links.
6. **Be honest in the record.** `forge job note` anything that failed or was skipped.

## Every invocation (except `update`) starts with
```bash
forge doctor   # once per session, and after a failure
forge sync     # PRs and trackers; cleans merged worktrees
forge requests # inbox requests: reference/requests.md, before new work
```
No `.forge/config.yml` (exit 2) → **init** unless told otherwise.
Report `sync`, a line each: merges, PR feedback, conflicts, finished umbrellas, `unblocked: true`/`integrating` (`/forge continue <id>`), `retargeted`. `forge sync` continues deferred merges itself (`merge` on the row).

## Commands (route on the first word)
| Arguments | Do |
|---|---|
| *(empty)* or `status` | `forge status`; summarise what runs, waits and comes next; offer `forge dash`. |
| `<free text>` | `forge job new --title "<short title>" --body "<the full request>" --session ${CLAUDE_SESSION_ID}`, then **Run a job**. |
| `next [n]` | `triage`, then up to `n` (default 1, max `runtime.maxParallelJobs`) times `forge next --claim --session ${CLAUDE_SESSION_ID}` (a queued job nobody drives, `resumed: true`, else a tracker item), then run them in parallel. |
| `issue <ref>` | `forge job from-ref <ref> --session ${CLAUDE_SESSION_ID}` (planned as one job), then **Run a job**. |
| `continue <job \| #pr \| ref> [note]` | `reference/pr-lifecycle.md` |
| `approve <job> [<ref>\|new\|none] [note]`, `revise`, `answer`, `rework`, `cancel <job> [note]` | record the decision (`reference/commands.md`); step moves the job; then **Run a job** |
| `sync` | the sync above; report |
| `dash` | `forge dash --background`; give the URL |
| `init`, `retro`, `eval …`, `requests`, `triage` | `reference/init.md`, `retro.md`, `evals.md`, `requests.md`, `triage.md` |
| `doctor` | `forge doctor`; explain failures and warnings with fixes; bug report: `forge doctor --bundle`, human checks its manifest |
| `update` | `forge update` only; report `from → to`, each `warnings` and `next` entry, or the error. |

## Run a job
Claim it: `forge job claim <id> --session ${CLAUDE_SESSION_ID}`, note its `epoch`. Exit 3: another live session owns it: tell the human, stop. Exit 4: blocked (dependencies, repo budget); report, move on (`--force` only if the human asks).

Then loop: `forge job advance <id> --session ${CLAUDE_SESSION_ID} --epoch <epoch>` (Bash timeout 600000), report each `tell` in `ran`, act on `action`, advance again.
- `spawn` (`verifier`: yes/no): run `startShell`. Spawn `agent` as `subagent_type` with `brief` as the prompt, `model` unless `inherit` and `effort` unless null (if `resume` names a live agent, SendMessage it the brief). At the first of its report or notification: `forge job agent <id> end --role <role> --agent-id <agentId> --import [--tokens <total_tokens> --tool-uses <tool_uses> --duration-ms <duration_ms>] --summary "<first line of its reply>"`. With `parallel: true`, spawn it in the background and advance at once. With `spawns`, run all `startShell`s in one Bash call, then spawn all in one message of background Agent calls. Then `forge job agent <id> attach --role <role> --agent-id <agentId>` for each, in one Bash call.
- `failed: true`: advance again; `parked: true` (it parked on `escalation`): report, stop. `capped: true`: advance again. Exit 3: stop (`stale_epoch`: taken over).
- `wait` on `agents`: end each as above; one not spawned by this session ends with `--status lost`.
- `wait` on a gate: report `tell` (for `input`, also `questions.md`) and stop driving it.
- `procedure`: follow `reference` (e.g. `reference/split.md`), then advance.
- `done`: report any `tell` and stop.
- `secret_found` outside advance: `forge job set <id> --state waiting --waiting-on human --reason "secret scan blocked <command>"`, report, stop; never retry or reword.

After `pr` or `done`, with the foreman off, `forge retro due`; if `due: true`, tell the human once that `/forge retro` proposes improvements (never run unasked). With the foreman on, `forge sync` queues the retro itself, and its spec still waits for a human.

## Parallel jobs
Drive up to `runtime.maxParallelJobs` jobs at once (a daemon job session, only its own).

## Reporting style
One line per job event: its id and, when blocked, the unblock command. Link the dashboard; no tables.
