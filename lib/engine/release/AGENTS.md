# lib/engine/release/

Releases: plans, runs and approvals, and interim releases across member repos.

- `interim.ts` is pure (no fs or git), so `forge job step` can import it; the git-dependent half is `interim-apply.ts`.
- This is the release flow Forge runs for the repos it works on; Forge's own release is `scripts/release.ts` (docs/RELEASES.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `approval.ts` | The `release` gate class (#192): a job's release plan the Foreman may approve in place of `forge release run`'s publish prompt. |
| `interim-apply.ts` | The side of interim strategies that touches git (docs/CONFIG.md "Interim strategies"): verify's pin refresh, the git-dependent edge states `forge job interim` and `pr open` read, and the one command in Forge that publishes anything, `forge job interim publish`. |
| `interim.ts` | Interim strategies: what a multi-repo job's consumer PR points at while its dependency's change is unmerged or unreleased (docs/CONFIG.md "Interim strategies"). |
| `plan.ts` | `forge release plan`: each repo's release strategy (lib/core/config/release-strategy.ts) and the repo graph turned into an ordered plan of checkable steps with rollback (docs/RELEASES.md "Releasing a project"). |
| `run.ts` | `forge release run` and `forge release status`: execute the release plan step by step with checkpoints in `.forge/runtime/release/state.json`, stop on the first failure, and resume there. |
<!-- forge:map:end -->
