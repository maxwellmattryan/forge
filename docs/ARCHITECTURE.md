# Architecture

Terms for projects with several repos are defined in [GLOSSARY.md](GLOSSARY.md).

- [Layers](architecture/layers.md): the engine, roster, repo layer, runtime state and the machine index, where each lives and when it changes, and which `forge` runs. Read it to decide where something outside `lib/` belongs.
- [Why a CLI does the bookkeeping](architecture/cli-bookkeeping.md): why every decision with one right answer is CLI code and agents only judge. Read it before moving work between an agent and the CLI.
- [Start-up cache](architecture/startup-cache.md): `bin/forge`'s code and stripped-module caches, their timings, and why they sit beside the code, plus the worktree seeds that share their directory and trust argument. Read it before touching `bin/forge`, start-up time or `lib/engine/workspace/seed.ts`.
- [Data and versioning](architecture/versioning.md): how every persisted shape is versioned and migrated, and the history of job, event, config and API versions. Read it before any shape change.
- [Updating](architecture/updating.md): `forge update`: detection, commands, refusals, versions and provenance. Read it when changing how Forge updates itself.
- [Job model](architecture/job-model.md): stages, states and `waitingOn`, moves, answered gates, the lease, evidence, budgets, dependencies and the inbox. Read it before changing how a job moves or who drives it.
- [Job repos](architecture/job-repos.md): member repos in one job, linked PRs and merge order, repo proposals, downstream verification, local links, and their threat models. Read it for any multi-repo change.
- [Interim strategies](architecture/interim-strategies.md): what a consumer's PR points at while its dependency is unmerged: deferral, pins, release gates and the threat model. Read it before changing interim releases.
- [Concurrency](architecture/concurrency.md): sessions per job and per repo, locks that prove death, one `forge dash` per repo, worktrees, ports and background commands. Read it before adding shared state or a lock.
- [Daemon](architecture/daemon.md): the session pool `forge dash` supervises: periodic sync, the reconciler, turn timeouts, states, triggers, the cap and budget holds. Read it before changing when sessions run.
- [Daemon runtime](architecture/daemon-runtime.md): session files and offsets, resume, failures, start and stop, effort, the HTTP surface, the terminal, orphans and the recorded stream-json framing. Read it before changing how a session is spawned, logged or stopped.
- [Foreman](architecture/foreman.md): how the Foreman decides gates: routing, its turn, the context rule, the authority the CLI enforces, the release gate class, ship policy, audit and threat model. Read it before changing what the Foreman may decide.
- [Audit trail](architecture/audit-trail.md): the actor every human action records, how it is resolved, why it is not authenticated, and export. Read it before adding a human action.
- [Retention](architecture/retention.md): archiving and pruning finished jobs: archive format, eligibility, write order, readers, logs and threat model. Read it before changing what Forge keeps or removes.
- [Deleting a job](architecture/deleting-a-job.md): `forge job delete`: what it refuses, its order of work and the dashboard card. Read it before changing job deletion.
- [Untrusted input](architecture/untrusted-input.md): how tracker, PR and request text reaches agents only as fenced data, why fork PRs are never adopted, and one wrapper per tool. Read it before anything that ingests outside text.
- [Policies](architecture/policies.md): authorship (AI attribution), review verdicts and model diversity, the repo budget, and usage accounting. Read it when changing a verdict, attribution or spend rule.
- [Dashboard security](architecture/dashboard-security.md): loopback Hosts only, the token, Origin and JSON every POST needs, read guards and the page CSP, plus the support bundle and `--dev`. Read it before adding or changing a route.
- [Daemon security](architecture/daemon-security.md): what an unattended session may run and change: one fixed stdin turn, argv from config, the trust digest, permission prompts and mode, git hooks off, orphan reaping and logs. Read it before changing a session's argv, env or permissions.
- [Release security](architecture/release-security.md): the release workflow's write token, who it defends against, pinned actions and residual risk. Read it before changing `release.yml` or `main-update.yml`.
