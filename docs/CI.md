# Forge's own CI

`.github/workflows/ci.yml` runs the [verify list](../AGENTS.md#verify-before-claiming-it-works) as named steps, in its order, on every PR, every push to `develop` and `main`, every call from another workflow (`workflow_call`) and every manual or dispatched run (`workflow_dispatch`, no inputs). Read this page when you change the workflow or the list; `test/ci-workflow.test.ts` fails when they differ.

## The verify job
- It runs on Node 22.18.0 (`.nvmrc`) and the latest Node 24, on Ubuntu only, each cell split in two by a `shard` axis: the test step there is `node --test --test-shard="$TEST_SHARD" "test/*.test.ts"`, with `TEST_SHARD` set from the matrix (`1/2`, `2/2`), so each half-suite runs on its own runner. That is the one command that differs from the list. The step also sets `FORGE_REQUIRE_DIST: '1'`: the tests that read the real dashboard build (`test/dist.ts` › `noDist()`) skip when `dashboard/dist/manifest.json` is missing, as on a fresh clone of `develop`, and with it set they run, and fail if the build step left nothing.
- For the last step it installs `@anthropic-ai/claude-code@2.1.299` from npm. That pin is the CLI version maintainers run locally, so CI validates by the same rules as a local run, even when the release is only days old (the action pins wait two weeks). Bump it in the workflow, here and AGENTS.md together. `claude plugin validate` needs no login, so CI runs it rather than skipping it.

## The other jobs
- **`audit`** runs `npm audit --omit=dev`, which blocks, and a report-only `npm audit`.
- **`release check`** runs `npm run release:check` after `verify` passes, choosing `--dist` from `REF` (the PR's base branch, or the pushed or dispatched branch, set in the step's `env`): `--dist absent` on `develop`, where `dashboard/dist/` must not be tracked; `--dist present` on `main`, where it must be tracked and match its build stamp; and no flag elsewhere, which checks the stamp only when dist is tracked.

`ci.yml` is also a reusable workflow (`workflow_call`, no inputs or secrets) that `release.yml` calls whole before it tags a release ([RELEASES.md](RELEASES.md)). `npm run release` waits for its push run on the release commit before it pushes `main`. Its bare `workflow_dispatch` re-runs it by hand; the token here stays read-only, so a dispatch can run nothing a PR couldn't.

## The main-update workflow
`.github/workflows/main-update.yml` runs on every push to `develop` and on `workflow_dispatch`, and its one job, `build`, also checks `github.ref == 'refs/heads/develop'`. It runs `npm ci` and `npm run build:dashboard` with the read-only token and uploads `dashboard/dist/` as the `dashboard-dist` artifact, kept 7 days. It writes nothing: `npm run release` checks that artifact and pushes `main` with the maintainer's own credentials ([RELEASES.md](RELEASES.md#releasing)). Its concurrency group is per commit, so a later push never cancels a release commit's pending build. `test/main-update-workflow.test.ts` pins its triggers, permissions, actions, expressions and commands, and that it uses no token or secret.

## What the test pins
`test/ci-workflow.test.ts` holds the workflow to allowlists of triggers, keys, `env`, actions and `${{ }}` expressions, and pins the job names, the Ubuntu runner, the matrix, the action inputs, every `run` (the release check's `--dist` choice and the audit steps included) and the single CLI install exactly, so changing any of those means editing the test in the same diff.
