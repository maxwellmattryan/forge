# Forge learnings

<!--
Lessons every Forge agent reads before starting. Written by the retro agent (via a reviewed
PR) and by humans. Keep each entry short, actionable and backed by evidence (job ids). Prune
entries that stop paying for themselves; this file is read on every agent run, so its length
costs tokens on every job.

Format:
- **<rule>** — why, evidence: <job ids>. (added YYYY-MM-DD · experiment: <id> · review-by: YYYY-MM-DD)
`experiment:` names an entry in experiments.md; `review-by:` is when the retro checks that its metric moved.
-->

- **Only one in-flight job may bump a version constant in `lib/schema.ts`** — two branches that both migrate from the same version merge into a broken migration table even when git reports no conflict; if your spec needs a bump and another open PR already has one, say so in `questions.md` and reply NEEDS-INPUT. Evidence: wave planning for issues #1–#23. (added 2026-10-12)
- **Jobs do not edit `CHANGELOG.md`, `package.json` version or `.claude-plugin/plugin.json` version** — every job touching them conflicts with every other; the release commit at the end of a wave adds them. Describe the change in `build.md` and the PR body instead. Evidence: wave planning. (added 2026-10-12)
- **New CLI commands go in `lib/commands/<group>.ts`, never in `lib/cli.ts`** — `cli.ts` only routes; growing it recreates the one-file collision the split removed. Evidence: #23. (added 2026-10-12)
- **Verify runs the base branch's `.forge/config.yml` commands, not the branch's** — a job that deletes or renames files a `commands.*` entry names, or adds a verify step, fails or silently skips that step until main's config changes. The spec lists the exact config edit under Infra & rollout as a human step to land on main before verify, and `commands.*` use `find` rather than shell globs that can match nothing. Evidence: dashboard-svelte-5-view-port-aig1 and engine-ts-surface-modules-and-vnos (each needed a human fix pushed to main), dashboard-vite-build-pipeline-compiled-3qc3, dashboard-strict-typescript-helpers-and-3mxp. (added 2026-10-13)
