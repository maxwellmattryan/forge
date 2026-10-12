# Tests lens

**Focus:** does the test suite prove the change works and keep it working?

Check:
- Every acceptance criterion in the spec has a test that would fail without the change.
- The AC table in the latest round of `build.md` has a row for every spec AC, and every proof exists: a test that would fail without the change, a runnable command, or a concrete manual step or screenshot.
- Edge cases from the spec (empty, max, invalid, concurrent, offline) are exercised.
- Tests assert behaviour, not implementation details; no snapshot-only coverage of logic.
- No flakiness sources: real clocks, network, random seeds, ordering assumptions, sleeps.
- Existing tests weren't weakened, skipped or deleted to make the build pass.
- Read the `## integrity` section of `verify/round-N.md`. Every deleted or renamed test, added skip/focus marker, negative test-count delta and test/CI config edit must be justified by the spec or `build.md`.
- Test names describe the behaviour; fixtures are minimal.

Run the configured test command yourself if the verify log is missing or stale.
Severity guide: an acceptance criterion with no test → major; AC table missing a row, or naming a proof that doesn't exist → major; a disabled/weakened test → blocker; an unjustified integrity finding → blocker.
