# lib/engine/release/

Releases: plans, runs and approvals, and interim releases across member repos.

- `interim.ts` is pure (no fs or git), so `forge job step` can import it; the git-dependent half is `interim-apply.ts`.
- `plan.ts` was split in #419, with runtime imports one way: `manifest.ts` imports nothing here, `steps.ts` imports only types from `plan.ts`, `plan.ts` imports `steps.ts` and `manifest.ts`, `render.ts` imports `plan.ts`, and `files.ts` imports `plan.ts` and `render.ts`.
- This is the release flow Forge runs for the repos it works on; Forge's own release is `scripts/release.ts` (docs/RELEASES.md).
- Design: [Interim strategies](../../../docs/architecture/interim-strategies.md), [Foreman](../../../docs/architecture/foreman.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `approval.ts` | The `release` gate class (#192): a job's release plan the Foreman may approve in place of `forge release run`'s publish prompt. |
| `files.ts` | The files in `.forge/runtime/release/` (their paths, symlink refusal, and reading `release.json` and `state.json` as untrusted data, since an agent session can write them) and `forge release plan`'s write. |
| `interim-apply.ts` | The side of interim strategies that touches git (docs/CONFIG.md "Interim strategies"): verify's pin refresh, the git-dependent edge states `forge job interim` and `pr open` read, and the one command in Forge that publishes anything, `forge job interim publish`. |
| `interim.ts` | Interim strategies: what a multi-repo job's consumer PR points at while its dependency's change is unmerged or unreleased (docs/CONFIG.md "Interim strategies"). |
| `manifest.ts` | The root package name and version read from a clone's `package.json` or `Cargo.toml`, filtered to what a registry accepts, and the ecosystem a repo's mechanism and registry publish to. |
| `plan.ts` | The release plan's shapes, and the planner that turns each repo's release strategy (lib/core/config/release-strategy.ts) and the repo graph into an ordered plan of checkable steps with rollback (docs/RELEASES.md "Releasing a project"). |
| `render.ts` | `release.md`, the human-readable plan with its checks and rollback. |
| `run.ts` | `forge release run` and `forge release status`: execute the release plan step by step with checkpoints in `.forge/runtime/release/state.json`, stop on the first failure, and resume there. |
| `steps.ts` | The mechanism table that turns one repo's strategy into release steps and their rollback lines. |
<!-- forge:map:end -->
