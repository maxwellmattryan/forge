# Forge experiments

<!--
One line per retro change: its date, `id <slug>` (what a learning's `experiment:` names), what
changed, the metric it should move (a dotted stats.json path such as `quality.avgRounds`), its
baseline, the evidence, and its status. A new entry always starts open; only
`forge experiment evaluate` settles one (kept | reverted | inconclusive), and `forge experiment
check` and verify refuse a status written by hand or any other edit to an existing entry.
-->

- 2026-10-13 · id builder-hostile-input · builder addendum: hostile-input checklist for engine code (.forge/notes/builder.md) · metric reviewers.security.changeRate (down) · baseline 0.344 (11/32) · evidence daemon-per-job-with-detailed-alva, daemon-supervisor-config-migration-and-roz1, 1-verify-reports-test-integrity-deleted, 17-measure-the-human-delta-after, 7-eval-worktrees-leak-the-solution, 4-wave2-ac-ui-proof-model-diversity · status inconclusive (2026-10-22, n 9, two-proportion, diff -0.392..0.178)
- 2026-10-13 · id spec-threat-model · spec-writer addendum: guards state a threat model with one AC per bypass (.forge/notes/spec-writer.md) · metric quality.avgRounds (down) · baseline 1.59 · evidence 1-verify-reports-test-integrity-deleted, 15-auto-merge-must-not-bypass, daemon-supervisor-config-migration-and-roz1 · status inconclusive (2026-10-22, n 12, bootstrap, diff -0.257..0.91)
- 2026-10-13 · id spec-live-session-proof · spec-writer addendum: live Claude Code checks get a runnable proxy proof and move to Infra & rollout (.forge/notes/spec-writer.md) · metric quality.escalationRate (down) · baseline 0.318 (7/22; 3 for unproven live-session ACs) · evidence engine-ts-toolchain-and-foundation-lkmo, engine-ts-surface-modules-and-vnos, daemon-per-job-with-detailed-alva · status inconclusive (2026-10-22, n 12, two-proportion, diff -0.141..0.473)
- 2026-10-13 · id verify-base-config · learning: verify runs the base branch's commands, so specs list config edits as a human pre-step (.forge/notes/learnings.md) · metric quality.verifyFirstPassRate (up) · baseline 0.591 · evidence dashboard-svelte-5-view-port-aig1, engine-ts-surface-modules-and-vnos, dashboard-vite-build-pipeline-compiled-3qc3, dashboard-strict-typescript-helpers-and-3mxp · status kept (2026-10-22, n 12, wilson, diff 0.166..0.409)
- 2026-10-13 · id docs-lens-narrow · config: narrow the docs lens `when` to CLI, config, /api and orchestrator changes (.forge/config.yml) · metric docs reviews per code review (down; guard: humanDeltaRate stays 0) · baseline 1.0 (35/35, docs changeRate 0) · evidence 35 docs reviews across all 22 reviewed jobs with 0 changes · status inconclusive (2026-10-22, metric is not a stats path)
