# Forge's own CI

`.github/workflows/ci.yml` runs the [verify list](../AGENTS.md#verify-before-claiming-it-works) as named steps, in its order, on every PR and every push to `main`. Read this page when you change the workflow or the list; `test/ci-workflow.test.ts` fails when they differ.

## The verify job
- It runs on Node 22.18.0 (`.nvmrc`) and the latest Node 24, on Ubuntu and macOS, each cell split in two by a `shard` axis: the test step there is `node --test --test-shard="$TEST_SHARD" "test/*.test.ts"`, with `TEST_SHARD` set from the matrix (`1/2`, `2/2`), so each half-suite runs on its own runner. That is the one command that differs from the list.
- For the last step it installs `@anthropic-ai/claude-code@2.1.299` from npm. That pin is the CLI version maintainers run locally, so CI validates by the same rules as a local run, even when the release is only days old (the action pins wait two weeks). Bump it in the workflow, here and AGENTS.md together. `claude plugin validate` needs no login, so CI runs it rather than skipping it.

## The other jobs
- **`audit`** runs `npm audit --omit=dev`, which blocks, and a report-only `npm audit`.
- **`windows (node 22.18.0)`** runs on `windows-latest` outside the list: `npm ci`, `npm run typecheck`, then `node scripts/windows-tests.ts`, which runs every `test/*.test.ts` except those named in the step's `WINDOWS_SKIP` block. Native Windows is unsupported (`docs/SUPPORT.md`), so the job only guards the cheap Windows fixes against regressions. Each skip is one line, `test/<file>.test.ts: <reason>`; the script exits 1 before running anything on a line with no reason, a path that isn't one existing test file, a repeat, or a list that leaves nothing to run, and `test/ci-workflow.test.ts` › "every Windows skip names an existing test file and its reason" holds the workflow to the same rule. Drop a skip once its file passes there.
- **`release check`** runs `npm run release:check` after `verify` passes.

`ci.yml` is also a reusable workflow (`workflow_call`, no inputs or secrets) that `release.yml` calls whole before it tags a release ([RELEASES.md](RELEASES.md)).

## What the test pins
`test/ci-workflow.test.ts` holds the workflow to allowlists of triggers, keys, `env`, actions and `${{ }}` expressions, and pins the job names, the matrix, the action inputs, every `run` (the stale-dist script and the audit steps included) and the single CLI install exactly, so changing any of those means editing the test in the same diff.
