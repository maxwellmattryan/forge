# lib/engine/evals/

Evals and self-improvement: eval runs and stats, experiments, learnings, retros, recall, scoring and provenance.

- `provenance.ts` hashes the files that shape what agents do (agents, reviewers, the skill, `lib/engine/pipeline/step/`, `step.ts` and `brief.ts`); moving any of them changes the plugin hash.
- Prefer measuring a prompt or policy change here (evals, `forge stats`) over arguing about it (docs/IMPROVEMENT.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `autonomy.ts` | The one definition of an autonomous job: Forge 1.0's test is a weekend unattended run with no human fixes, and this judges each merged job against it once its outcome is final. |
| `experiments.ts` | Settling the experiment ledger. |
| `learnings.ts` | Learnings carry an experiment and a review-by date, so the retro can check whether each one still moves its metric instead of letting stale lessons cost tokens on every run forever. |
| `outcome.ts` | A merged job's outcome: whether its merge was reverted, drew follow-up bug issues or churned inside a window after the merge. |
| `overlay.ts` | Per-run config overlays for evals: `forge eval start --set key=value` records typed values on the run and on each eval job, and every command that acts on such a job reads its config through configForJob. |
| `provenance.ts` | Which prompts, plugin and repo layer a run used. |
| `recall.ts` | The cheap eval tier for reviewer prompts: frozen diffs with planted defects (and clean ones), reviewed by `forge:reviewer` under the prompts being changed, then graded by recall (planted defects caught) and precision (clean fixtures left alone). |
| `retro.ts` | Assembles the retro agent's inputs deterministically, so the expensive model spends its context on judgement rather than on trawling job folders. |
| `run.ts` | Forge evaluation. |
| `scoring.ts` | Post-merge scoring: a sampled share of merged jobs gets one run of the judge against the spec's acceptance criteria and the merged PR's diff, so real work has a quality score beside the evals'. |
| `stats.ts` | Eval statistics: where a job's time went, and n / mean / min / max over a run's repeats, so an A/B comparison shows the sample behind every number. |
<!-- forge:map:end -->
