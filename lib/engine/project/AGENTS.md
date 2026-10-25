# lib/engine/project/

Multi-repo projects: member repos and trackers, a job's repos and their order, proposals, links and downstream checks, and the machine index of registered projects.

- `member-repos.ts` holds the member repo validators that `lib/core/` still reads through allowed upward edges; they move down into `lib/core/config/` later (docs/design/lib-layout.md › Today's upward edges).
- Design: [Job repos](../../../docs/architecture/job-repos.md), [Interim strategies](../../../docs/architecture/interim-strategies.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `downstream.ts` | Downstream verification: when a job changes a library, the member repos that consume it join the job as verify-only repos, so verify runs their tests against the job's changes through local links (docs/CONFIG.md "Downstream verification", docs/architecture/job-repos.md). |
| `graph.ts` | The project graph GET /api/project serves: `components` reduced to names, repos, kinds, paths and dependsOn edges. |
| `job-repos.ts` | Job repos: the member repos (config `repos`) one job changes beside the root repo. |
| `links.ts` | Local links: while a multi-repo job is in progress, a consumer repo builds against the dependency's job worktree instead of its released version (docs/CONFIG.md "Components", docs/architecture/job-repos.md "Local links"). |
| `machine-index.ts` | The machine index: the projects registered on this machine in `<FORGE_HOME>/projects.json`, never their config, commands or secrets. |
| `member-repos.ts` | Member repos: the other repos a project spans (`config.repos`), and where each is cloned on this machine (`.forge/local.yml`, gitignored). |
| `member-trackers.ts` | Member repo trackers: the GitHub issue trackers of config `repos` entries, read and written beside the root's. |
| `repo-order.ts` | The merge order of a multi-repo job's PRs, from config `components[].dependsOn`: repo A depends on repo B when a component in A depends on one in B. |
| `repo-proposals.ts` | Repo proposals: a planner or spec-writer that finds the job needs a change in another member repo proposes it (`forge job repo propose`), and the job parks (step RP1) until a human, or the foreman when `repo-proposal` is in foreman.decides, approves or rejects it (`forge job human … approve-repos \| reject-repos`, or the dashboard). |
| `trust-approval.ts` | What a human last approved for each project: the trustDigest of the files Forge trusts (config, notes, reviewers, CLAUDE.md, AGENTS.md…) when they pressed Start or ran `forge dash` in that repo. |
<!-- forge:map:end -->
