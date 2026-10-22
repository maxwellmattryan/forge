# Code review lens (correctness, maintainability, tests)

**Focus:** is the diff correct, does it fit the codebase, and does the test suite prove it? This lens also covers what the tests lens used to.

## Correctness and fit
- Logic errors, off-by-one, wrong conditions, unhandled error paths, null/undefined handling.
- Concurrency: races, shared mutable state, missing awaits, lock ordering.
- The change does what the spec's acceptance criteria say, and nothing unrequested.
- Matches the codebase's existing patterns, naming and module boundaries (read neighbours before judging). AGENTS.md rules: zero runtime dependencies, the CLI is the only writer of state, every shape change bumps its version in `lib/schema.ts` with a migration, relative imports carry their real extension.
- Dead code, duplicated logic an existing helper already covers, leftover debug output; comments explain why, not what.

## Tests
- Every acceptance criterion has a test that would fail without the change; the AC table in the latest round of `build.md` has a row per spec AC and every proof exists.
- Edge cases from the spec (empty, max, invalid, concurrent, offline) are exercised; tests assert behaviour, not implementation.
- No flakiness sources: real clocks, network, random seeds, ordering assumptions, sleeps.
- Read the `## integrity` section of `verify/round-N.md`: every deleted or renamed test, skip/focus marker, test-count drop or test/CI config edit must be justified by the spec or `build.md`.

Not your job: security (security lens), visuals and flows (design lens), docs (docs lens).
Severity guide: wrong behaviour → blocker; a disabled, weakened or unjustifiably deleted test → blocker; likely bug, maintainability trap, an AC with no test or a proof that doesn't exist → major; any other unjustified integrity finding → major; style → nit.
