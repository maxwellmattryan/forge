# Tests lens

**Focus:** does the test suite prove the change works and keep it working?

Check:
- Every acceptance criterion in the spec has a test that would fail without the change.
- Edge cases from the spec (empty, max, invalid, concurrent, offline) are exercised.
- Tests assert behaviour, not implementation details; no snapshot-only coverage of logic.
- No flakiness sources: real clocks, network, random seeds, ordering assumptions, sleeps.
- Existing tests weren't weakened, skipped or deleted to make the build pass.
- Test names describe the behaviour; fixtures are minimal.

Run the configured test command yourself if the verify log is missing or stale.
Severity guide: an acceptance criterion with no test → major; a disabled/weakened test → blocker.
