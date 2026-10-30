# Deleting a job

`forge job delete <id> [--force]` (`lib/engine/ops/delete.ts`) and the drawer's **Delete job** card (`POST /api/jobs/:id/delete`) remove a job started by mistake, for good. Unlike archiving, nothing is kept: no archive record, so `forge stats`, audit and retro never count it; one `{ type: "deleted", kind: "job", id, title, trigger: cli|dashboard, actor }` line in `.forge/runtime/retention.log` records who deleted what.

**Refused**, with nothing changed, for an eval job; a job with a PR (real work: cancel and archive it); a live interactive owner (unless `--force`); a running daemon session (the CLI refuses; the dashboard stops the job's own session itself, once nothing else refuses); a split parent whose children still exist; and a job an active job `dependsOn`. Like archive and prune, it exits 1 in any daemon session, and an office run runs only its seven office commands.

**Order of work.** Check everything; mirror the job to the tracker as cancelled (best effort), which releases its issues; `removeWorktree` with `--force` (the root and member worktrees, background commands, per-job backing services) and, only when the branch is the one Forge named (`git.branchPrefix` + id), the branch; reject the job's open requests; delete its daemon session record and logs; then, inside the job's lock with the owner re-checked, the job dir. A failed worktree or backing teardown stops before the job dir goes, so a rerun finishes.

**Dashboard.** The POST needs the token, a matching Origin and JSON like every other, and its body must be `{"confirm": "<id>"}`: the card arms only once the id is typed back, so a stray or replayed click never deletes a job nobody named. The card offers no delete for an eval job or one with a PR.
